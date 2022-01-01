//

'use strict';

import './scss/app.scss';
import $ from 'jquery';
import * as digitaljs from 'digitaljs';
import * as digitaljs_lua from 'digitaljs_lua';
import Split from 'split-grid';

const vscode = window.acquireVsCodeApi();

class DigitalJS {
    constructor() {
        this.helpers = {};
        this.circuit = undefined;
        this.monitor = undefined;
        this.monitormem = undefined;
        this.monitorview = undefined;
        this.paper = undefined;
        Split({
            rowGutters: [{
                element: document.querySelector('#gutter_vert'),
                track: 1
            }]
        });
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'showcircuit':
                    this.mkCircuit(message.circuit, message.opts);
                    return;
            }
        });
        this.updateRunStates();
    }

    luaError(name, e) {
        vscode.postMessage({ command: "luaerror", name, message: e.luaMessage });
    }
    makeLuaRunner(name, circuit) {
        const runner = new digitaljs_lua.LuaRunner(circuit);
        runner.on('thread:stop', (pid) => {
            vscode.postMessage({ command: "luastop", name });
        });
        runner.on('thread:error', (pid, e) => {
            this.luaError(name, e);
        });
        runner.on('print', msgs => {
            vscode.postMessage({ command: "luaprint", name, messages: msgs });
        });
        this.helpers[name] = runner;
    }
    runLua(name, script) {
        let pid;
        try {
            pid = this.helpers[name].runThread(script);
            this.helpers[name].running_pid = pid;
        }
        catch (e) {
            if (e instanceof digitaljs_lua.LuaError) {
                luaError(name, e);
            }
            else {
                throw e;
            }
        }
        if (pid !== undefined) {
            vscode.postMessage({ command: "luastarted", name });
        }
    }
    stopLua(name) {
        const helper = this.helpers[name];
        if (!helper)
            return;
        const pid = helper.running_pid;
        if (pid === undefined)
            return;
        if (helper.isThreadRunning(pid)) {
            helper.stopThread(pid);
            delete helper.running_pid;
        }
    }

    registerMarkers(paper) {
        paper.on('cell:mouseover', (cellView) => {
            let markers = [];
            const positions = cellView.model.get('source_positions');
            if (!positions)
                return;
            for (const pos of positions)
                markers.push({from_line: pos.from.line, from_col: pos.from.column,
                              to_line: pos.to.line, to_col: pos.to.column});
            vscode.postMessage({ command: "showmarker", markers });
        });
        paper.on('cell:mouseout', (cellView) => {
            vscode.postMessage({ command: "clearmarker" });
        });
    }
    updateCircuit() {
        vscode.postMessage({ command: "updatecircuit", circuit: this.circuit.toJSON() });
    }
    mkCircuit(data, opts) {
        if (opts.transform)
            data = digitaljs.transform.transformCircuit(data);
        this.destroyCircuit();
        const circuit_opts = {
            layoutEngine: 'elkjs',
            engine: digitaljs.engines.WorkerEngine,
            engineOptions: { workerURL: window.simWorkerUri }
        };
        this.circuit = new digitaljs.Circuit(data, circuit_opts);
        // If transform is on, update the host about the transformed circuit.
        if (opts.transform)
            this.updateCircuit();
        this.circuit.on('postUpdateGates', (tick) => {
            vscode.postMessage({ command: "tick", tick });
        });
        this.circuit.start();
        this.monitor = new digitaljs.Monitor(this.circuit);
        if (this.monitormem) {
            this.monitor.loadWiresDesc(this.monitormem);
            this.monitormem = undefined;
        }
        this.monitorview = new digitaljs.MonitorView({model: this.monitor, el: $('#monitor') });
        // TODO: IOPanel
        this.paper = this.circuit.displayOn($('<div>').appendTo($('#paper')));
        this.registerMarkers(this.paper);
        this.circuit.on('new:paper', (paper) => { this.registerMarkers(paper); });
        this.circuit.on('userChange', () => {
            this.updateCircuit();
            this.updateRunStates();
        });
        this.circuit.on('changeRunning', () => {
            this.updateRunStates();
        });
        this.updateRunStates();
        $('#monitorbox button').prop('disabled', false);
        $('#monitorbox button[name=ppt_up]').on('click', (e) => { this.monitorview.pixelsPerTick *= 2; });
        $('#monitorbox button[name=ppt_down]').on('click', (e) => { this.monitorview.pixelsPerTick /= 2; });
        $('#monitorbox button[name=left]').on('click', (e) => {
            this.monitorview.live = false;
            this.monitorview.start -= this.monitorview.width / this.monitorview.pixelsPerTick / 4;
        });
        $('#monitorbox button[name=right]').on('click', (e) => {
            thils.monitorview.live = false;
            this.monitorview.start += this.monitorview.width / this.monitorview.pixelsPerTick / 4;
        });
        $('#monitorbox button[name=live]')
            .toggleClass('active', this.monitorview.live)
            .on('click', (e) => {
                this.monitorview.live = !this.monitorview.live;
                if (this.monitorview.live)
                    this.monitorview.start = this.circuit.tick - this.monitorview.width / this.monitorview.pixelsPerTick;
            });
        this.monitorview.on('change:live', (live) => { $('#monitorbox button[name=live]').toggleClass('active', live) });
        this.monitor.on('add', () => {
            if ($('#monitorbox').height() == 0)
                $('html > body > div').css('grid-template-rows', (idx, old) => {
                    const z = old.split(' ');
                    z[1] = '3fr';
                    z[3] = '1fr';
                    return z.join(' ');
                });
        });
        const show_range = () => {
            $('#monitorbox input[name=rangel]').val(Math.round(this.monitorview.start));
            $('#monitorbox input[name=rangeh]').val(Math.round(this.monitorview.start + this.monitorview.width / this.monitorview.pixelsPerTick));
        };
        const show_scale = () => {
            $('#monitorbox input[name=scale]').val(this.monitorview.gridStep);
        };
        show_range();
        show_scale();
        this.monitorview.on('change:start', show_range);
        this.monitorview.on('change:pixelsPerTick', show_scale);
    }

    updateRunStates() {
        const circuit = this.circuit;
        if (circuit === undefined) {
            vscode.postMessage({ command: "runstate",
                                 running: false, pendingEvents: false });
            return;
        }
        vscode.postMessage({ command: "runstate",
                             running: circuit.running,
                             pendingEvents: circuit.hasPendingEvents });
        this.monitorview.autoredraw = !circuit.running;
    }
    destroyCircuit() {
        if (this.monitor) {
            // remember which signals were monitored
            this.monitormem = this.monitor.getWiresDesc();
        }
        if (this.circuit) {
            this.circuit.shutdown();
            this.circuit = undefined;
        }
        if (this.paper) {
            this.paper.remove();
            this.paper = undefined;
        }
        if (this.monitorview) {
            this.monitorview.shutdown();
            this.monitorview = undefined;
        }
        if (this.monitor) {
            this.monitor.stopListening();
            this.monitor = undefined;
        }
        for (const h of Object.values(this.helpers))
            h.shutdown();
        this.helpers = {};
        this.updateRunStates();
    }
    pauseSim() {
        this.circuit.stop();
    }
    startSim() {
        this.circuit.start();
    }
    singleStepSim() {
        this.circuit.updateGates();
        this.updateRunStates();
    }
    nextEventSim() {
        this.circuit.updateGatesNext();
        this.updateRunStates();
    }
    fastForwardSim() {
        this.circuit.startFast();
        this.updateRunStates();
    }
}

$(window).on('load', () => {
    const digitaljs = new DigitalJS();
});
