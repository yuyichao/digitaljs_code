//

'use strict';

import $ from 'jquery';

function get_content_rect(svg, svgrect) {
    // jointjs's paper size is larger than the content size,
    // first figure out the content size and offset.
    let realrect;
    for (const child of svg.children) {
        const rect = child.getBoundingClientRect();
        if (rect.width == 0 || rect.height == 0)
            continue;
        if (!realrect) {
            realrect = rect;
            continue;
        }
        const x1 = Math.min(realrect.x, rect.x);
        const x2 = Math.max(realrect.right, rect.right);
        const y1 = Math.min(realrect.y, rect.y);
        const y2 = Math.max(realrect.bottom, rect.bottom);
        realrect = new DOMRect(x1, y1, x2 - x1, y2 - y1);
    }
    if (!realrect)
        return;
    realrect.x -= svgrect.x;
    realrect.y -= svgrect.y;
    return realrect;
}

// Copied and adapted from html-to-image
function replace_input(node, parent, opts) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", 'text');
    parent.appendChild(text);
    const input = $(node).find('input');
    text.innerHTML = input.val();

    const node_rect = node.getBoundingClientRect();
    let transform = node.getAttribute('transform');
    transform = `${transform || ''} translate(${node_rect.width / 2} ${node_rect.height / 2})`;
    text.setAttribute('transform', transform);
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-family', 'monospace');
    const input_style = window.getComputedStyle(input[0]);
    if (input_style.fontSize)
        text.setAttribute('font-size', input_style.fontSize);
    if (input_style.fontWeight)
        text.setAttribute('font-weight', input_style.fontWeight);
    text.setAttribute('fill', input_style.color || 'black');
    return text;
}

function clone_node(node, parent, in_foreign, opts = {}) {
    // This is the only foreign object we care about AFAICT
    if (node.tagName == 'foreignObject') {
        if (!node.classList.contains('valinput'))
            return;
        in_foreign = true;
        if (opts.replaceInput) {
            return replace_input(node, parent, opts);
        }
    }

    const cloned = node.cloneNode(false);
    const children = node.childNodes;
    const nchildren = children.length;

    if (node instanceof HTMLInputElement)
        cloned.setAttribute('value', node.value)

    if (!in_foreign && opts.stripAttr && cloned.attributes) {
        // Filter attribute names
        const nattrs = cloned.attributes.length;
        const to_remove = [];
        for (let i = 0; i < nattrs; i++) {
            const name = cloned.attributes[i].name;
            if (name === 'class') { // we'll replace it with explicit styles
                to_remove.push(name);
            }
            else if (name.startsWith('joint-')) {
                to_remove.push(name);
            }
            else if (name === 'model-id' || name === 'data-type') {
                // These are joint specific afaict
                to_remove.push(name);
            }
        }
        for (const name of to_remove) {
            cloned.removeAttribute(name);
        }
    }

    parent.appendChild(cloned);

    if (cloned instanceof Element)
        clone_css_style(node, cloned, in_foreign);

    for (const child of children)
        clone_node(child, cloned, in_foreign, opts);

    return cloned;
}

function clone_css_style(node, cloned, in_foreign) {
    const source = window.getComputedStyle(node);
    const target_origin = window.getComputedStyle(cloned);
    const target = cloned.style

    if (!target)
        return

    const nstyles = source.length;
    for (let i = 0; i < nstyles; i++) {
        const name = source[i];
        if (name.startsWith('-')) // ignore vendor specific styles
            continue;
        if (name == 'cursor')
            continue; // doesn't matter for rendering
        const src_val = source.getPropertyValue(name);
        // For valinput, the default when rendering seems to be different
        // from when it is in the document so we'll set all the properties for it.
        if (!in_foreign && src_val == target_origin.getPropertyValue(name))
            continue;
        target.setProperty(name, src_val, source.getPropertyPriority(name));
    }
}

function svg_to_dataurl(svg) {
    const xml = new XMLSerializer().serializeToString(svg);
    const encoded = encodeURIComponent(xml);
    return `data:image/svg+xml;charset=utf-8,${encoded}`;
}

function to_image(svg) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
        img.decoding = 'sync';
        img.src = svg_to_dataurl(svg);
    });
}

function to_canvas(rect, img) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    // XXX: Hardcode pixel ratio for now.
    //      I'm not sure yet what's the best way to determine this...
    const ratio = 4;

    const canvasWidth = rect.width
    const canvasHeight = rect.height

    canvas.width = canvasWidth * ratio;
    canvas.height = canvasHeight * ratio;

    canvas.style.width = `${canvasWidth}`
    canvas.style.height = `${canvasHeight}`

    context.drawImage(img, rect.x, rect.y, rect.width, rect.height,
                      0, 0, canvas.width, canvas.height);
    return canvas;
}

function clone_svg(svg, opts = { stripAttr: true, replaceInput: true }) {
    // Add to the DOM temporarily to get the default style
    const cloned_svg = clone_node(svg, document.body, false, opts);
    const svgrect = cloned_svg.getBoundingClientRect();
    const content_rect = get_content_rect(cloned_svg, svgrect);
    document.body.removeChild(cloned_svg);
    if (!content_rect)
        return;

    cloned_svg.setAttribute('width', `${svgrect.width}`);
    cloned_svg.setAttribute('height', `${svgrect.height}`);
    cloned_svg.setAttribute('viewBox', `0 0 ${svgrect.width} ${svgrect.height}`);
    // Leave some clipping margin
    content_rect.x -= 2;
    content_rect.y -= 2;
    content_rect.width += 4;
    content_rect.height += 4;
    return { svg: cloned_svg, rect: content_rect };
}

export function toSvg(svg) {
    const res = clone_svg(svg);
    if (!res)
        return;
    const { svg: cloned_svg, rect } = res;
    cloned_svg.setAttribute('width', `${rect.width}`);
    cloned_svg.setAttribute('height', `${rect.height}`);
    cloned_svg.setAttribute('viewBox', `${rect.x} ${rect.y} ${rect.width} ${rect.height}`);
    return new XMLSerializer().serializeToString(cloned_svg);
}

export async function toCanvas(svg) {
    const res = clone_svg(svg);
    if (!res)
        return;
    const { svg: cloned_svg, rect } = res;
    return to_canvas(rect, await to_image(cloned_svg));
}
