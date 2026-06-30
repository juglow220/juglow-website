const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const TEAM_MEMBER_ID = process.env.SQUARE_TEAM_MEMBER_ID;
const BASE_URL = 'https://connect.squareup.com/v2';

const headers = {
  'Authorization': `Bearer ${SQUARE_TOKEN}`,
  'Square-Version': '2024-01-18',
  'Content-Type': 'application/json'
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

async function getVariationId(serviceId) {
  const res = await fetch(`${BASE_URL}/catalog/object/${serviceId}?include_related_objects=true`, { headers });
  const data = await res.json();
  const variations = data.object?.item_data?.variations;
  return variations?.[0]?.id || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  const action = event.queryStringParameters?.action;

  try {

    // ── Catalog: list all bookable services ──
    if (action === 'catalog') {
      const res = await fetch(`${BASE_URL}/catalog/list?types=ITEM`, { headers });
      const data = await res.json();
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    }

    // ── Availability ──
    if (action === 'availability') {
      const { serviceId, date } = event.queryStringParameters;

      const variationId = await getVariationId(serviceId);
      if (!variationId) {
        return {
          statusCode: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Could not find variation for service ${serviceId}` })
        };
      }

      const startAt = `${date}T00:00:00-05:00`;
      const endAt   = `${date}T23:59:59-05:00`;

      const body = {
        query: {
          filter: {
            start_at_range: { start_at: startAt, end_at: endAt },
            location_id: LOCATION_ID,
            segment_filters: [{
              service_variation_id: variationId,
              team_member_id_filter: { any: [TEAM_MEMBER_ID] }
            }]
          }
        }
      };

      const res = await fetch(`${BASE_URL}/bookings/availability/search`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      const data = await res.json();
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    }

    // ── Create Booking ──
    if (action === 'book' && event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body);
      const { serviceId, startAt, customerName, customerEmail, customerPhone } = payload;

      const variationId = await getVariationId(serviceId);
      if (!variationId) {
        return {
          statusCode: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ errors: [{ detail: `Could not find variation for service ${serviceId}` }] })
        };
      }

      // Find or create customer
      let customerId = null;
      try {
        const searchRes = await fetch(`${BASE_URL}/customers/search`, {
          method: 'POST', headers,
          body: JSON.stringify({ query: { filter: { email_address: { exact: customerEmail } } } })
        });
        const searchData = await searchRes.json();
        if (searchData.customers?.length > 0) customerId = searchData.customers[0].id;
      } catch(e) {}

      if (!customerId) {
        const nameParts = customerName.trim().split(' ');
        const createRes = await fetch(`${BASE_URL}/customers`, {
          method: 'POST', headers,
          body: JSON.stringify({
            given_name: nameParts[0],
            family_name: nameParts.slice(1).join(' ') || '',
            email_address: customerEmail,
            phone_number: customerPhone
          })
        });
        const createData = await createRes.json();
        customerId = createData.customer?.id;
      }

      // Create booking
      const bookingRes = await fetch(`${BASE_URL}/bookings`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `${Date.now()}-${Math.random()}`,
          booking: {
            location_id: LOCATION_ID,
            customer_id: customerId,
            start_at: startAt,
            appointment_segments: [{
              service_variation_id: variationId,
              team_member_id: TEAM_MEMBER_ID,
              service_variation_version: 1
            }]
          }
        })
      });

      const bookingData = await bookingRes.json();
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingData)
      };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
