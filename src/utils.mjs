//

'use strict';

import * as vscode from 'vscode';
import { createHash } from 'crypto';

export function hash_sha512(data) {
    return createHash('sha512').update(data).digest('hex');
}

export function rel_compat1(uri) {
    return uri && !uri.fragment && !uri.query;
}

export function rel_compat2(uri1, uri2) {
    // Assuming that `!uri1` or `rel_compat1(uri1) === true`
    if (!uri1 || !rel_compat1(uri2))
        return false;
    return uri1.authority == uri2.authority && uri1.scheme == uri2.scheme;
}

export async function read_txt_file(uri) {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}
