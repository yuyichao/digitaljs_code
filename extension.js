// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    let panel;
    context.subscriptions.push(vscode.commands.registerCommand('digitaljs.openView', function () {
        const column = vscode.window.activeTextEditor ?
                       vscode.window.activeTextEditor.viewColumn : undefined;
        if (panel) {
            panel.reveal(column);
            return;
        }
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', true);
        panel = vscode.window.createWebviewPanel(
            'digitaljsView',
            'DigitalJS',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'imgs', 'digitaljs.svg');
        panel.onDidDispose(() => {
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', false);
            panel = undefined;
        });
        panel.onDidChangeViewState((e) => {
            const panel = e.webviewPanel;
            if (panel.visible) {
                vscode.commands.executeCommand('digitaljs-proj-files.focus');
            }
        });
        const js_path = vscode.Uri.joinPath(context.extensionUri, 'dist', 'view-bundle.js');
        panel.webview.html = getWebviewContent(panel.webview.asWebviewUri(js_path));
        vscode.commands.executeCommand('digitaljs-proj-files.focus');
    }));
}

// this method is called when your extension is deactivated
function deactivate() {
}

function getWebviewContent(js_url) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>
    window.acquireVsCodeApi = acquireVsCodeApi;
  </script>
  <script src="${js_url}"></script>
  <title>DigitalJS Code</title>
</head>
<body>
<div id="grid">
  <div id="toolbar">
    <div class="btn-toolbar" role="toolbar" aria-label="Toolbar">
      <div class="mr-2">
        <div class="digitaljs_logo" title="DigitalJS"></div>
      </div>
      <div class="symbola btn-group mr-2" role="group" aria-label="Time control">
        <button name="pause" type="button" class="btn btn-secondary" title="Pause simulation" disabled="true">⏸</button>
        <button name="resume" type="button" class="btn btn-secondary" title="Resume simulation" disabled="true">▶</button>
        <button name="fastfw" type="button" class="btn btn-secondary" title="Fast-forward simulation" disabled="true">⏩</button>
        <button name="single" type="button" class="btn btn-secondary" title="Run single time step" disabled="true">→</button>
        <button name="next" type="button" class="btn btn-secondary" title="Run until next event" disabled="true">⇥</button>
      </div>
      <div class="input-group mr-2">
        <div class="input-group-prepend">
          <span class="symbola input-group-text" title="Current tick">⏱</span>
        </div>
        <input type="text" class="form-control" disabled="disabled" id="tick" />
      </div>
      <div class="symbola btn-group mr-2" role="group" aria-label="Saving and sharing">
        <button name="load" type="button" class="btn btn-secondary" title="Load from file" disabled="true">📁</button>
        <button name="save" type="button" class="btn btn-secondary" title="Save to file" disabled="true">💾</button>
        <button name="link" type="button" class="btn btn-secondary" title="Get link" disabled="true">🔗</button>
      </div>
    </div>
  </div>
  <div id="editor">
    <nav>
      <div class="nav nav-tabs" role="tablist">
        <a href="#start" class="nav-item nav-link active" role="tab" data-toggle="tab" aria-controls="start" aria-selected="true">Setup</a>
        <a href="#iopanel" class="nav-item nav-link" role="tab" data-toggle="tab" aria-controls="start" aria-selected="true">I/O</a>
      </div>
    </nav>
    <div class="tab-content">
      <div role="tabpanel" class="tab-pane tab-padded active" id="start">
        <form>
          <div class="form-group form-check" data-bs-toggle="tooltip" title="Enables Yosys optimizations of the synthesized circuit. This might make the circuit differ significantly to its HDL specification. This corresponds to the 'opt -full' Yosys command.">
            <input type="checkbox" id="opt" class="form-check-input">
            <label for="opt" class="form-check-label">Optimize in Yosys</label>
          </div>
          <div class="form-group form-check" data-bs-toggle="tooltip" title="Enables post-processing of Yosys output to reduce the number of components and improve readability.">
            <input type="checkbox" id="transform" class="form-check-input" checked>
            <label for="transform" class="form-check-label">Simplify diagram</label>
          </div>
          <div class="form-group form-check" data-bs-toggle="tooltip" title="Enables checking for common problems using the Verilator compiler.">
            <input type="checkbox" id="lint" class="form-check-input" checked>
            <label for="lint" class="form-check-label">Lint source code using <a href="https://verilator.org/">Verilator</a></label>
          </div>
          <div class="form-group" data-bs-toggle="tooltip" title="Changes how the circuit elements are automatically positioned after synthesis.">
            <label for="layout">Layout engine</label>
            <select id="layout" class="form-control">
              <option value="elkjs">ElkJS (more readable)</option>
              <option value="dagre">Dagre (legacy)</option>
            </select>
          </div>
          <div class="form-group" data-bs-toggle="tooltip" title="Changes how the synthesized circuit is simulated. The synchronous engine is well tested, but it's also very slow.">
            <label for="engine">Simulation engine</label>
            <select id="engine" class="form-control">
              <option value="worker">WebWorker (faster and responsive)</option>
              <option value="synch">Synchronous (extensible but slow)</option>
            </select>
          </div>
          <div class="form-group" data-bs-toggle="tooltip" title="Enables finite state machine processing in Yosys. This corresponds to the 'fsm' and 'fsm -nomap' Yosys commands.">
            <label for="fsm">FSM transform (experimental)</label>
            <select id="fsm" class="form-control">
              <option value="">No FSM transform</option>
              <option value="yes">FSM transform</option>
              <option value="nomap">FSM as circuit element</option>
            </select>
          </div>
          <div class="form-group form-check" data-bs-toggle="tooltip" title="This corresponds to the 'fsm_expand' Yosys command.">
            <input type="checkbox" id="fsmexpand" class="form-check-input">
            <label for="fsmexpand" class="form-check-label">Merge more logic into FSM</label>
          </div>
        </form>
      </div>
      <div role="tabpanel" class="tab-pane tab-padded" id="iopanel">
      </div>
    </div>
    <div id="synthesize-bar">
      <form>
        <button type="submit" class="btn btn-primary">Synthesize and simulate!</button>
      </form>
    </div>
  </div>
  <div id="gutter_horiz" class="gutter gutter-horizontal"></div>
  <div id="paper">
  </div>
  <div id="gutter_vert" class="gutter gutter-vertical"></div>
  <div id="monitorbox">
    <div class="btn-toolbar" role="toolbar" aria-label="Toolbar">
      <div class="symbola btn-group mr-2" role="group" aria-label="Scale control">
        <button name="ppt_up" type="button" class="btn btn-secondary" title="Increase pixels per tick" disabled="true">+</button>
        <button name="ppt_down" type="button" class="btn btn-secondary" title="Decrease pixels per tick" disabled="true">-</button>
      </div>
      <div class="input-group mr-2">
        <div class="input-group-prepend">
          <span class="input-group-text" title="Ticks per grid line">scale</span>
        </div>
        <input type="text" class="form-control" disabled="disabled" name="scale" />
      </div>
      <div class="symbola btn-group mr-2" role="group" aria-label="Time control">
        <button name="live" type="button" class="btn btn-secondary" title="Live mode" disabled="true">▶</button>
        <button name="left" type="button" class="btn btn-secondary" title="Move left" disabled="true">←</button>
        <button name="right" type="button" class="btn btn-secondary" title="Move right" disabled="true">→</button>
      </div>
      <div class="input-group mr-2">
        <div class="input-group-prepend">
          <span class="input-group-text" title="Display range">range</span>
        </div>
        <input type="text" class="form-control" disabled="disabled" name="rangel" />
        <div class="input-group-prepend input-group-append">
          <span class="input-group-text">–</span>
        </div>
        <input type="text" class="form-control" disabled="disabled" name="rangeh" />
      </div>
    </div>
    <div id="monitor">
    </div>
  </div>
</div>
</body>
</html>`;
}

module.exports = {
    activate,
    deactivate
}
