// HTTP entry point. Every request is a POST with
//   ?ts=<unix seconds>&sig=<hex hmac>&exec_type=<action>
// and a JSON body. The signature is HMAC-SHA256 over "ts.exec_type.body"
// with the API_SECRET script property as the key.

const MAX_CLOCK_SKEW_SECONDS = 60;

function doPost(e) {
  let out;
  try {
    out = handleRequest_(e);
  } catch (err) {
    out = { ok: false, error: errorMessage_(err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleRequest_(e) {
  const SECRET = PropertiesService.getScriptProperties().getProperty("API_SECRET");
  if (!SECRET) return deny_("Server not configured");

  const body = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
  const query = (e && e.parameter) ? e.parameter : {};
  const ts = query.ts ? String(query.ts) : "";
  const sig = query.sig ? String(query.sig) : "";
  const exec_type = query.exec_type ? String(query.exec_type) : "";

  if (!ts || !sig) return deny_("Missing ts/sig");
  if (!/^\d{1,12}$/.test(ts)) return deny_("Bad ts");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > MAX_CLOCK_SKEW_SECONDS) return deny_("Expired");

  const msg = ts + "." + exec_type + "." + body;
  const raw = Utilities.computeHmacSha256Signature(msg, SECRET, Utilities.Charset.UTF_8);
  const expected = raw.map(b => ("0" + ((b & 0xff).toString(16))).slice(-2)).join("");
  if (!safeEqual_(expected, sig.toLowerCase())) return deny_("Invalid signature");

  let params;
  try {
    params = JSON.parse(body || "{}");
  } catch (err) {
    return deny_("Body is not valid JSON");
  }

  return exec(exec_type, params);
}

function deny_(msg) {
  return { ok: false, error: msg, return_value: msg };
}

function errorMessage_(err) {
  return (err && err.message) ? String(err.message) : String(err);
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return out === 0;
}
