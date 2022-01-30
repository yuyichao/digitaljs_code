//

'use strict';

import * as vscode from 'vscode';
import { CircuitView } from './circuit_view.mjs';
import { Document } from './document.mjs';
import { read_txt_file } from './utils.mjs';

export class EditorProvider {
    static viewType = 'digitaljs.circuitView'
    static viewType_json = 'digitaljs.circuitView_json'
    #djs
    onDidChangeCustomDocument
    #onDidChangeCustomDocument
    constructor(djs) {
        this.#djs = djs;
        this.#onDidChangeCustomDocument = new vscode.EventEmitter();
        this.onDidChangeCustomDocument = this.#onDidChangeCustomDocument.event;
    }

    backupCustomDocument(document, context, _cancel) {
        return document.backup(context.destination);
    }

    async openCustomDocument(uri, context, _cancel) {
        let txt;
        if (context.untitledDocumentData) {
            txt = new TextDecoder().decode(context.untitledDocumentData);
        }
        else {
            const file = context.backupId ? vscode.Uri.parse(context.backupId) : uri;
            txt = (file && file.scheme !== 'untitled') ? await read_txt_file(file) : '{}';
        }
        const data = JSON.parse(txt);
        const document = new Document(uri, data);
        document.documentEdited(e => {
            this.#onDidChangeCustomDocument.fire(e);
        });
        return document;
    }

    async resolveCustomEditor(document, panel, _cancel) {
        panel.webview.options = {
            enableScripts: true,
        };
        const circuit_view = new CircuitView(this.#djs, panel, document);
        await circuit_view.init();
        this.#djs.registerDocument(document, circuit_view);
        return;
    }

    async revertCustomDocument(document, _cancel) {
        const uri = document.uri;
        // actually vscode doesn't seems to ever call revert for untitled document...
        if (!uri || uri.scheme == 'untitled')
            return document.revert({});
        const str = await read_txt_file(uri);
        const json = JSON.parse(str);
        if (typeof json !== "object" || json === null)
            throw `${uri} is not a valid JSON object.`
        return document.revert(json);
    }

    saveCustomDocument(document, _cancel) {
        return document.save();
    }

    saveCustomDocumentAs(document, uri, _cancel) {
        return document.saveAs(uri);
    }
}
