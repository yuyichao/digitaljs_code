//

'use strict';

import Backbone from 'backbone';
import { Vector3vl } from '3vl';

export class RemoteIOPanel extends Backbone.View {
    initialize(args) {
        this.vscode = args.vscode;
        this.render();
        this.listenTo(this.model._graph, 'add', () => { this.render() });
        this.listenTo(this.model._graph, 'remove', () => { this.render() });
        this.listenTo(this.model, "display:add", () => { this.render() });
    }
    processMessage(message) {
        switch (message.command) {
            case 'iopanel:update': {
                const updater = this.updater[message.id];
                if (updater) {
                    updater(message.value);
                }
            }
        }
    }
    render() {
        this.stopListening();
        this.view = [];
        this.updater = {};
        for (const element of this.model._graph.getElements()) {
            const celltype = element.get('type');
            if (celltype !== 'Clock' && celltype !== '$clock')
                continue;
            this._addClock(element);
        }
        for (const element of this.model.getInputCells())
            this._addInput(element);
        for (const element of this.model.getOutputCells())
            this._addOutput(element);
        this.vscode.postMessage({ command: "iopanel:view", view: this.view });
    }
    shutdown() {
        this.stopListening();
        this.vscode.postMessage({ command: "iopanel:view", view: [] });
    }
    _createRow(cell) {
        return {
            id: cell.id,
            label: cell.get('net') || cell.get('label')
        }
    }
    _addInput(cell) {
        const row = this._createRow(cell);
        row.dir = 'input';
        this.view.push(row);
        const bits = cell.get('bits');
        row.bits = bits;
        this.updater[row.id] = (val) => {
            cell.setInput(Vector3vl.fromBin(val, bits));
        };
        row.value = cell.get('outputSignals').out.toBin();
        this.listenTo(cell, 'change:outputSignals', (cell, sigs) => {
            this.vscode.postMessage({ command: "iopanel:update",
                                      id: row.id, value: sigs.out.toBin() });
        });
    }
    _addClock(cell) {
        const row = this._createRow(cell);
        row.dir = 'clock';
        this.view.push(row);
        this.updater[row.id] = (val) => {
            cell.set('propagation', val);
        };
        row.value = cell.get('propagation');
        this.listenTo(cell, 'change:propagation', (cell, value) => {
            this.vscode.postMessage({ command: "iopanel:update",
                                      id: row.id, value: value });
        });
    }
    _addOutput(cell) {
        const row = this._createRow(cell);
        row.dir = 'output';
        this.view.push(row);
        const bits = cell.get('bits');
        row.bits = bits;
        row.value = cell.getOutput().toBin();
        this.listenTo(cell, 'change:inputSignals', (cell, sigs) => {
            this.vscode.postMessage({ command: "iopanel:update",
                                      id: row.id, value: cell.getOutput().toBin() });
        });
    }
};
