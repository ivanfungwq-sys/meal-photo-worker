// Meal photo upload/serve worker, backed by an R2 bucket.
// Endpoints:
//   POST   /upload              multipart/form-data with field "photo" -> { key, url }
//   POST   /upload?analyze=true same as above, plus asks Claude to identify the meal
//                                and estimate calories/macros -> { key, url, analysis }
//   GET    /photo/:key          streams the stored image back
//   DELETE /photo/:key          removes a stored image
//
// Requires an R2 binding named MEAL_PHOTOS (see wrangler.toml).
// For the analyze feature, set a secret: `wrangler secret put ANTHROPIC_API_KEY`
// The key lives only on the Worker — it is never sent to or stored in the client.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ANALYSIS_MODEL = 'claude-haiku-4-5-20251001';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function analyzeMealPhoto(arrayBuffer, mimeType, apiKey) {
  const base64 = arrayBufferToBase64(arrayBuffer);
  const prompt =
    'You are a nutrition estimation assistant. Look at this meal photo and identify the food(s). ' +
    'Respond with ONLY a single JSON object, no markdown fences, no extra commentary, in exactly this shape: ' +
    '{"name": "short food description", "calories": number, "protein": number, "carbs": number, "fat": number}. ' +
    'calories is kcal; protein/carbs/fat are grams. These are your best estimate for the visible portion. ' +
    'If there are multiple items, combine them into one entry with a combined name.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found in model response');

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('Model response was not valid JSON');
  }

  return {
    name: String(parsed.name || 'Scanned meal').slice(0, 120),
    calories: Math.max(0, Number(parsed.calories) || 0),
    protein: Math.max(0, Number(parsed.protein) || 0),
    carbs: Math.max(0, Number(parsed.carbs) || 0),
    fat: Math.max(0, Number(parsed.fat) || 0),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method === 'POST' && url.pathname === '/upload') {
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.includes('multipart/form-data')) {
        return json({ error: 'Expected multipart/form-data with a "photo" field' }, 400);
      }

      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return json({ error: 'Could not parse form data' }, 400);
      }

      const file = form.get('photo');
      if (!file || typeof file.arrayBuffer !== 'function') {
        return json({ error: 'No "photo" file field found' }, 400);
      }

      const mimeType = file.type || 'image/jpeg';
      const ext = mimeType.split('/')[1] || 'jpg';
      const key = `meals/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const arrayBuffer = await file.arrayBuffer();

      await env.MEAL_PHOTOS.put(key, arrayBuffer, {
        httpMetadata: { contentType: mimeType },
      });

      const photoUrl = `${url.origin}/photo/${encodeURIComponent(key)}`;
      const wantsAnalysis = url.searchParams.get('analyze') === 'true';

      if (wantsAnalysis) {
        if (!env.ANTHROPIC_API_KEY) {
          return json({ key, url: photoUrl, analysis: null, analysisError: 'ANTHROPIC_API_KEY secret not set on the Worker' });
        }
        try {
          const analysis = await analyzeMealPhoto(arrayBuffer, mimeType, env.ANTHROPIC_API_KEY);
          return json({ key, url: photoUrl, analysis });
        } catch (e) {
          return json({ key, url: photoUrl, analysis: null, analysisError: e.message });
        }
      }

      return json({ key, url: photoUrl });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/photo/')) {
      const key = decodeURIComponent(url.pathname.replace('/photo/', ''));
      const obj = await env.MEAL_PHOTOS.get(key);
      if (!obj) return new Response('Not found', { status: 404, headers: CORS });

      return new Response(obj.body, {
        headers: {
          ...CORS,
          'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/photo/')) {
      const key = decodeURIComponent(url.pathname.replace('/photo/', ''));
      await env.MEAL_PHOTOS.delete(key);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};
