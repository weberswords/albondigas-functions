const Mailgun = require('mailgun.js');

// Wraps the official mailgun.js client in the interface the deprecated
// mailgun-js package had, so callers keep using
// mailgun({ apiKey, domain }).messages().send(mailData, callback).
module.exports = ({ apiKey, domain }) => {
    const client = new Mailgun(FormData).client({ username: 'api', key: apiKey });
    return {
        messages: () => ({
            send: (mailData, callback) => {
                client.messages.create(domain, mailData)
                    .then((body) => callback(null, body))
                    .catch((error) => callback(error));
            }
        })
    };
};
