[![vscode marketspace](https://img.shields.io/badge/VS%20Code-DigitalJS-green)](https://marketplace.visualstudio.com/items?itemName=yuyichao.digitaljs)
[![openvsx registry](https://img.shields.io/badge/Open%20VSX-DigitalJS-green)](https://open-vsx.org/extension/yuyichao/digitaljs)

This is an extension that brings the
[DigitalJS](https://github.com/tilk/digitaljs) digital logic simulator
and the [yosys2digitaljs](https://github.com/tilk/yosys2digitaljs)
netlist format converter to VS code.
It provides similar functionalities as the [online version](https://digitaljs.tilk.eu/)
while allowing you to work directly with local source files and saving your progress,
including source information and the synthesized circuit, for future use.
It also includes other additional features like undo-redo, exporting the circuit to images
and more.

This was made possible by [DigitalJS](https://github.com/tilk/digitaljs),
[yosys2digitaljs](https://github.com/tilk/yosys2digitaljs)
and many other related projects by [Marek Materzok](http://www.tilk.eu/),
[University of Wrocław](http://www.ii.uni.wroc.pl/) as well as
the [Yosys](http://www.clifford.at/yosys/) open-source hardware synthesis framework.
This also borrows idea and code heavily from the original online version:
[DigitalJS Online](https://github.com/tilk/digitaljs_online).

Contributions are welcome!

![screenshot](./imgs/screenshots/code-highlight.png)

# Features

* Simulation of circuit (using [DigitalJS](https://github.com/tilk/digitaljs)) including support for

    * Continuous simulation
    * Single step
    * Trigger
    * Signal monitor and plotting.

* Saving/backing up the circuit including the source file information in a portable format

  (The relative paths of the source files are saved and so that the project can be fully
   restored on another machine as long as the source files are also packaged/copied with
   the project/circuit file)

  The saved file can be loaded in the [online version](https://digitaljs.tilk.eu/)
  for simulation.

* Open the JSON circuit saved by the [online version](https://digitaljs.tilk.eu/)
  for simulation. Accepted extensions are either `.json` or `.digitaljs`.
  `.digitaljs` will be openned by default using this extension.

* __Exporting the synthesized circuit as vector (SVG) or raster images (PNG or JPEG)__.

* Undo and redo all the changes on the circuit including but not limited to
  resynthesize of the circuit and edits done from the graphic view of the circuit.

* Highlighting the source code that matches certain circuit element in the graphic view.

* Using `Lua` scripts to customize/seed the simulation
  (using [`digitaljs_lua`](https://github.com/tilk/digitaljs_lua))

* Viewing and simulation multiple circuits simultaneously

* Can run either fully locally using the native version of VS Code,
  or fully on the web using the web version of VS Code
  (e.g. [vscode.dev](https://vscode.dev/), [github.dev](https://github.dev/) or [gitpod.io](https://gitpod.io/))
