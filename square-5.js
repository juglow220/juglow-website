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

// Pick the best variation off an ITEM: prefer one that actually has a
// service_duration set (appointment items should always have this), since
// variations[0] is not guaranteed to be the "active"/current one — a
// discontinued or legacy variation can sit first in Square's array.
function pickVariation(item) {
  const variations = item.item_data?.variations || [];
  const withDuration = variations.find(v => v.item_variation_data?.service_duration);
  return withDuration || variations[0];
}

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
        const variation = pickVariation(match);
        return {
          variationId: variation?.id,
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
    const variation = pickVariation(match);
    return {
      variationId: variation?.id,
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
        .map(s => {
          const v = pickVariation(s);
          return {
            id: s.id,
            name: s.item_data?.name,
            variationId: v?.id,
            duration: v?.item_variation_data?.service_duration,
            allVariations: (s.item_data?.variations || []).map(x => ({
              id: x.id,
              name: x.item_variation_data?.name,
              duration: x.item_variation_data?.service_duration
            }))
          };
        });
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ services: simplified })
      };
    }

    // ── Lookup: get variationId + duration for a service name ──
    if (action === 'lookup') {
      const { serviceName } = event.queryStringParameters;
      const found = await findVariationId(serviceName);
      if (!found) {
        return {
          statusCode: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Service not found: ${serviceName}` })
        };
      }
      // Get the duration from catalog — match the SAME variation we're booking
      // (found.variationId), not just variations[0], since variation order in
      // Square's array isn't guaranteed to put the active/correct one first.
      const res = await fetch(`${BASE_URL}/catalog/object/${found.serviceId}`, { headers });
      const data = await res.json();
      const variations = data.object?.item_data?.variations || [];
      const matchedVariation = variations.find(v => v.id === found.variationId) || variations[0];
      const rawDuration = matchedVariation?.item_variation_data?.service_duration;
      if (!rawDuration) {
        console.error(`No service_duration found for "${serviceName}" (serviceId: ${found.serviceId}, variationId: ${found.variationId}). Variations:`, JSON.stringify(variations.map(v => ({ id: v.id, name: v.item_variation_data?.name, duration: v.item_variation_data?.service_duration }))));
      }
      const duration = rawDuration || 1800000;
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ variationId: found.variationId, durationMinutes: Math.round(duration / 60000) })
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

    // ── Create Booking (supports multiple appointment segments) ──
    if (action === 'book' && event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body);
      const { variationId, startAt, customerName, customerEmail, customerPhone, segments } = payload;

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

      // Build appointment_segments — either from the provided segments array (multi-service)
      // or fall back to the single variationId (backwards compatible)
      const appointmentSegments = (segments && segments.length > 0)
        ? segments.map(s => ({
            service_variation_id: s.variationId,
            team_member_id: TEAM_MEMBER_ID,
            service_variation_version: 1,
            duration_minutes: s.durationMinutes
          }))
        : [{
            service_variation_id: variationId,
            team_member_id: TEAM_MEMBER_ID,
            service_variation_version: 1
          }];

      const bookingRes = await fetch(`${BASE_URL}/bookings`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `${Date.now()}-${Math.random()}`,
          booking: {
            location_id: LOCATION_ID,
            customer_id: customerId,
            start_at: startAt,
            appointment_segments: appointmentSegments
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
