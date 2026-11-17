function doPost(e) {
  const SECRET = PropertiesService.getScriptProperties().getProperty("API_SECRET");
  if (!SECRET) {
    return ContentService
      .createTextOutput("Server not configured")
      .setMimeType(ContentService.MimeType.TEXT);
  }

  const body = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
  const ts = (e && e.parameter && e.parameter.ts) ? String(e.parameter.ts) : "";
  const sig = (e && e.parameter && e.parameter.sig) ? String(e.parameter.sig) : "";
  const exec_type = (e && e.parameter && e.parameter.exec_type) ? String(e.parameter.exec_type) : "";


  if (!ts || !sig) return deny_("Missing ts/sig");
  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return deny_("Bad ts");
  if (Math.abs(now - tsNum) > 60) return deny_("Expired"); // 60s window


  const msg = ts + "." + body;
  const raw = Utilities.computeHmacSha256Signature(msg, SECRET, Utilities.Charset.UTF_8);
  const expected = raw.map(b => ("0" + ((b & 0xff).toString(16))).slice(-2)).join("");

 
  if (!safeEqual_(expected, sig.toLowerCase())) return deny_("Invalid signature");
  const params = JSON.parse(body);

/* 
 CHANGE: Handle false emails, current mailer doesnt send error back when sent a jibberish email

 CHANGE: removeZipFiles make a function that lays out zip files like return json dirs selectively
 * delete one or more zip files either pass array or one file name 
 * 
 CHANGE: Refactor month and year to be month_year : [{month : '' , year: ''}]

 */ 

 const exec_ret_obj =  exec(exec_type, params); 


  return ContentService
    .createTextOutput(JSON.stringify(exec_ret_obj)).setMimeType(ContentService.MimeType.JSON);
}



function deny_(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return out === 0;
}
