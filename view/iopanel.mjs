"use strict";

import Backbone from 'backbone';
import { Vector3vl } from '3vl';

export class RemoteIOPanel extends Backbone.View {
    initialize(args) {
        this.djs = args.djs;
        this.vscode = args.vscode;
        this.render();
        this.listenTo(this.model._graph, 'add', this._handleAdd);
        this.listenTo(this.model._graph, 'remove', this._handleRemove);
        this.listenTo(this.model, "display:add", () => { this.render() });
    }
    render() {
        this.view = [];
        this.updater = {};
        for (const element of this.model.getInputCells())
            this._handleAddInput(element);
        for (const element of this.model.getOutputCells())
            this._handleAddOutput(element);
        this.vscode.postMessage({ command: "iopanel:view", view: this.view });
    }
    shutdown() {
        this.stopListening();
    }
    _handleAdd(cell) {
        if (cell.isInput) {
            this._handleAddInput(cell);
        }
        else if (cell.isOutput) {
            this._handleAddOutput(cell);
        }
    }
    _createRow(cell) {
        return {
            id: cell.id,
            label: cell.get('net') || cell.get('label')
        }
    }
    _handleAddInput(cell) {
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
    _handleAddOutput(cell) {
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
    _handleRemove(cell) {
        this.stopListening(cell);
        this.render();
    }
};
