// Copy this file to Config.gs (in the Apps Script editor: a script file named "Config")
// and fill in your values. Config.gs is gitignored. Do not paste this example file
// into Apps Script next to the real one: both define getConfig_.
function getConfig_() {
  return {
    // ID of the Drive folder that holds the invoice archives (the part after /folders/ in its URL)
    ROOT_FOLDER_ID: 'YOUR_DRIVE_FOLDER_ID',
    // Used to find or create the folder when the ID above is not accessible
    ROOT_FOLDER_NAME: 'dataccent-invoice-mail',
    MAIL_LIST: {
      USER: 'you@example.com',
      ACCOUNTANT: 'accountant@example.com'
    }
  };
}
