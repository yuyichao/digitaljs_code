//

'use strict';

const vscode = require('vscode');
let yosys2digitaljs;

if (process.browser) {
    yosys2digitaljs = async function (req_body) {
        const server = vscode.workspace.getConfiguration('digitaljs').get('serverURL');
        req_body = JSON.stringify(req_body);
        const response = await fetch(server + "/api/yosys2digitaljs", {
            method: 'POST',
            mode: 'cors',
            headers: {
                "Content-Type": "application/json",
            },
            body: req_body
        });
        let reply;
        try {
            reply = await response.json();
        }
        catch (e) {
            if (response.status < 200 || response.status >= 300)
                throw new Error(`[${response.status}] ${await response.text()}`);
            throw e;
        }
        if (response.status < 200 || response.status >= 300) {
            reply.statusCode = response.status;
            throw reply;
        }
        return reply;
    }
}
else {
    const https = require('https');

    yosys2digitaljs = function (req_body) {
        const server = vscode.workspace.getConfiguration('digitaljs').get('serverURL');
        req_body = JSON.stringify(req_body);
        return new Promise((resolve, reject) => {
            // assume https for now...
            const req = https.request(server, {
                "path": "/api/yosys2digitaljs",
                "method": "POST",
                headers: {
                    "accept": "*/*",
                    "accept-encoding": "gzip,deflate,br",
                    "content-length": req_body.length,
                    "content-type": "application/json",
                },
                rejectUnauthorized: false // workaround let's encrypt certificate issue...
            }, (res) => {
                let rep_body = [];
                res.on('data', function(chunk) {
                    rep_body.push(chunk);
                });
                res.on('end', function() {
                    rep_body = Buffer.concat(rep_body).toString()
                    try {
                        rep_body = JSON.parse(rep_body);
                    }
                    catch (e) {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            reject(new Error(`[${res.statusCode}] ${rep_body}`));
                            return;
                        }
                        reject(e);
                        return;
                    }
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        rep_body.statusCode = res.statusCode;
                        reject(rep_body);
                        return;
                    }
                    resolve(rep_body);
                });
            });
            req.on('error', function(err) {
                reject(err);
            });
            req.write(req_body);
            req.end();
        });
    }
}
export { yosys2digitaljs };
