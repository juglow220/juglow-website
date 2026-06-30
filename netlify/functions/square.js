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

// Map website service names → Square service names (for fuzzy matching)
const SERVICE_NAME_MAP = {
  'signature brow': 'signature brow threading',
  'brow + lip + chin': 'brow + lip + chin threading',
  'brow + lip': 'brow + lip threading',
  'full facial hair': 'full facial hair threading',
  'juglow signature facial': 'juglow signature facial',
  'timeless facial': 'timeless facial',
  'clarity ritual': 'clarity facial',
  'radiance ritual': 'radiance facial',
  'refined edit': 'refined edit',
  'eye refinement ritual': 'eye refinement',
  'signature juglow experience': 'signature juglow experience',
  'smooth confidence': 'smooth confidence',
  'lactic acid peel': 'lactic acid advanced skin surfacing',
  'salicylic acid peel': 'salicylic acid advanced skin surfacing',
  'microdermabrasion': 'microdermabrasion',
  'brow tint': 'brow tint',
  'brow lamination': 'brow lamination',
  'korean lash lift': 'korean lash lift',
  'brazilian wax': 'brazilian wax',
  'underarm wax': 'underarm wax',
};

// Find the best matching Square service for a website service name
async function findVariationId(websiteServiceName) {
  const res = await fetch(`${BASE_URL}/catalog/list?types=ITEM`, { headers });
  const data = await res.json();
  const services = data.objects || [];

  const lower = websiteServiceName.toLowerCase();

  // First try: find a mapped keyword match
  for (const [keyword, squareKeyword] of Object.entries(SERVICE_NAME_MAP)) {
    if (lower.includes(keyword)) {
      const match = services.find(s =>
        s.type === 'ITEM' &&
        s.item_data?.name?.toLowerCase().includes(squareKeyword)
      );
      if (match) {
        return {
          variationId: match.item_data.variations[0].id,
          serviceId: match.id
        };
      }
    }
  }

  // Second try: direct word overlap
  const words = lower.split(/\s+/).filter(w => w.length > 4);
  const match = services.find(s => {
    const sqLower = s.item_data?.name?.toLowerCase() || '';
    return s.type === 'ITEM' && words.some(w => sqLower.includes(w));
  });

  if (match) {
    return {
      variationId: match.item_data.variations[0].id,
      serviceId: match.id
    };
  }

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  const action = event.queryStringParameters?.action;

  try {

    // ── List services (debug) ──
    if (action === 'services') {
      const res = await fetch(`${BASE_URL}/catalog/list?types=ITEM`, { headers });
      const data = await res.json();
      const simplified = (data.objects || [])
        .filter(s => s.type === 'ITEM')
        .map(s => ({
          id: s.id,
          name: s.item_data?.name,
          variationId: s.item_data?.variations?.[0]?.id,
          duration: s.item_data?.variations?.[0]?.item_variation_data?.service_duration
        }));
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ services: simplified })
      };
    }

    // ── Availability ──
    if (action === 'availability') {
      const { serviceName, date } = event.queryStringParameters;

      const found = await findVariationId(serviceName);
      if (!found) {
        return {
          statusCode: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ availabilities: [], error: `No match for: ${serviceName}` })
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
              service_variation_id: found.variationId,
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
        body: JSON.stringify({ ...data, variationId: found.variationId })
      };
    }

    // ── Create Booking ──
    if (action === 'book' && event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body);
      const { variationId, startAt, customerName, customerEmail, customerPhone } = payload;

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
