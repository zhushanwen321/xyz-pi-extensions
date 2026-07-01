#!/usr/bin/env python3
"""Auto-layout a logical graph into draw.io XML using Graphviz.

Minimal layout pass for the drawio skill: takes a graph (nodes + edges as
JSON), runs `dot` to position the nodes, and emits a .drawio file with the
mxGeometry x/y filled in. draw.io routes the edges itself (orthogonal style).
This removes the manual-coordinate ceiling for medium/large diagrams.

Input JSON:
  {
    "direction": "TB",          # TB (top-bottom, default) or LR (left-right)
    "nodes": [
      {"id": "a", "label": "Service A", "style": "rounded=1;...",
       "width": 120, "height": 60}
    ],
    "edges": [
      {"source": "a", "target": "b", "label": "calls"}
    ]
  }
Only "id" is required per node; label defaults to id and style/width/height
have defaults. Node ids must be unique and must not be "0" or "1" (reserved
for the draw.io root cells). Requires Graphviz `dot` on PATH.

Usage: python3 autolayout.py graph.json [-o diagram.drawio]
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
from xml.sax.saxutils import escape

DEFAULT_W, DEFAULT_H = 120, 60
NODE_STYLE_LIGHT = "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#1e3a5f;"
NODE_STYLE_DARK = "rounded=1;whiteSpace=wrap;html=1;fillColor=#0d2424;strokeColor=#5eead4;fontColor=#e3efee;"
# orthogonalEdgeStyle = right-angle routing; rounded = smooth corners; jettySize=auto =
# adaptive segment length so parallel edges don't stack on top of each other.
EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;"
GROUP_STYLE_LIGHT = ("rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#999999;"
                     "fontColor=#666666;verticalAlign=top;fontStyle=2;dashed=1;")
GROUP_STYLE_DARK = ("rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#64748b;"
                    "fontColor=#94a3b8;verticalAlign=top;fontStyle=2;dashed=1;")
# Group colours come from the skill's own palette (styles/built-in/default.json)
# so there is a single source of truth, not a second list baked in here. When a
# grouped graph is laid out, each top-level group takes the next colour (cycled
# in a fixed, harmonious role order) so related modules read as a coloured
# cluster. Nodes that carry their own `style` keep it; only styleless grouped
# nodes are tinted. Disable with --mono.
_PALETTE_ORDER = ["primary", "success", "accent", "secondary", "warning", "danger", "neutral"]
_PALETTE_FILE = os.path.join(os.path.dirname(__file__), "..", "styles", "built-in", "default.json")
_FALLBACK_PALETTE = [("#dae8fc", "#6c8ebf"), ("#d5e8d4", "#82b366"), ("#ffe6cc", "#d79b00"),
                     ("#e1d5e7", "#9673a6"), ("#fff2cc", "#d6b656"), ("#f8cecc", "#b85450")]


def load_palette(theme="light"):
    """Ordered (fill, stroke, fontColor) tuples from the default preset's palette;
    fall back to the same colours inline if the preset file can't be read.

    theme selects between the light palette (default) and paletteDark.
    fontColor is None when the preset doesn't define one (light palette).
    """
    key = "paletteDark" if theme == "dark" else "palette"
    try:
        with open(_PALETTE_FILE, encoding="utf-8") as fh:
            pal = json.load(fh)[key]
        colors = []
        for r in _PALETTE_ORDER:
            if r not in pal:
                continue
            colors.append((pal[r]["fillColor"], pal[r]["strokeColor"],
                           pal[r].get("fontColor")))
        if colors:
            return colors
    except (OSError, KeyError, ValueError):
        pass
    # Fallback has no fontColor.
    return [(f, s, None) for f, s in _FALLBACK_PALETTE]


PALETTE = load_palette()  # light palette; dark is loaded on demand via --theme
# Uniform container padding; the title sits in the top pad (verticalAlign=top).
# dot's cluster margin is set to this same value so each container box equals
# dot's cluster box — which dot guarantees never overlaps, at any nesting depth.
GROUP_PAD = 24


def attr(value):
    return escape(str(value), {'"': "&quot;"})


def dot_quote(value):
    # Wrap as a DOT double-quoted string, escaping backslash and quote so ids
    # with those characters can't corrupt the Graphviz input.
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def snap(value, grid=10):
    # Align to the grid the skill uses everywhere (multiples of 10).
    return int(round(value / grid) * grid)


def clamp_ratio(value):
    """Clamp a draw.io exit/entry ratio to [0, 1] and round to 2 decimals.

    Ratios outside [0,1] (e.g. when a Graphviz exit point lands just past a node
    edge due to spline snapping) cause draw.io to render the connector floating
    in space. Clamping anchors the endpoint firmly on the node border.
    """
    return round(min(1.0, max(0.0, value)), 2)


def group_tree(nodes):
    """Parse hierarchical `group` paths ("a/b") into a container tree.

    Returns (gpath, direct, children, ordered):
      gpath[node_id] = tuple of path segments (the node's deepest container)
      direct[path]   = node ids whose group is exactly this path
      children[path] = child container paths
      ordered        = all container paths, shallow-to-deep (stable)
    """
    gpath, direct, paths = {}, {}, set()
    for node in nodes:
        g = node.get("group")
        if g is None or str(g).strip("/") == "":
            continue
        t = tuple(str(g).strip("/").split("/"))
        gpath[node["id"]] = t
        direct.setdefault(t, []).append(node["id"])
        for k in range(1, len(t) + 1):
            paths.add(t[:k])
    children = {}
    for p in sorted(paths):
        if len(p) > 1:
            children.setdefault(p[:-1], []).append(p)
    ordered = sorted(paths, key=lambda p: (len(p), p))
    return gpath, direct, children, ordered


def build_dot(graph):
    rankdir = "LR" if str(graph.get("direction", "TB")).upper() == "LR" else "TB"
    # splines=ortho makes dot route edges as orthogonal polylines; we replay
    # those bends as draw.io waypoints so edges go around nodes, not through them.
    lines = [f"digraph G {{ rankdir={rankdir}; splines=ortho; node [shape=box fixedsize=true];"]
    # Group nodes into (possibly nested) clusters so dot keeps each group
    # together; a node's first appearance fixes its cluster, so list members
    # before the size attributes. The cluster margin reserves room for the
    # padded container boxes we draw below (extra on Y for the title strip) so
    # neighbouring boxes do not overlap.
    _, direct, children, ordered = group_tree(graph["nodes"])
    cidx = {p: i for i, p in enumerate(ordered)}

    def emit_cluster(p, pad):
        lines.append(f'{pad}subgraph cluster_{cidx[p]} {{ margin={GROUP_PAD};')
        for c in children.get(p, []):
            emit_cluster(c, pad + "  ")
        lines.extend(f'{pad}  {dot_quote(m)};' for m in direct.get(p, []))
        lines.append(pad + "}")

    for root in [p for p in ordered if len(p) == 1]:
        emit_cluster(root, "")
    for node in graph["nodes"]:
        # Pass our pixel sizes to dot as inches so it lays out at the real size.
        w = node.get("width", DEFAULT_W) / 72.0
        h = node.get("height", DEFAULT_H) / 72.0
        lines.append(f'{dot_quote(node["id"])} [width={w:.4f} height={h:.4f}];')
    for edge in graph.get("edges", []):
        lines.append(f'{dot_quote(edge["source"])} -> {dot_quote(edge["target"])};')
    lines.append("}")
    return "\n".join(lines)


def layout(dot_src):
    """Run `dot -Tplain`; return (height_in, {id: (xc, yc)}, {(src, dst): [(x, y), ...]}).

    Node coords are inches (bottom-left origin); each edge's value is the list
    of orthogonal control points dot computed for routing, endpoints included.
    """
    try:
        proc = subprocess.run(
            ["dot", "-Tplain"], input=dot_src,
            capture_output=True, text=True, check=True,
        )
    except FileNotFoundError:
        sys.exit("error: Graphviz `dot` not found on PATH (brew install graphviz)")
    except subprocess.CalledProcessError as exc:
        sys.exit(f"error: dot failed: {exc.stderr.strip()}")
    height, pos, edges = 0.0, {}, {}
    for line in proc.stdout.splitlines():
        tok = shlex.split(line)
        if not tok:
            continue
        if tok[0] == "graph":
            height = float(tok[3])                        # graph scale width height
        elif tok[0] == "node":
            pos[tok[1]] = (float(tok[2]), float(tok[3]))  # node name x y ...
        elif tok[0] == "edge":                            # edge tail head n x1 y1 ... xn yn
            n = int(tok[3])
            edges[(tok[1], tok[2])] = [
                (float(tok[4 + 2 * i]), float(tok[5 + 2 * i])) for i in range(n)
            ]
    return height, pos, edges


def group_style(stroke, font_color="#666666"):
    """Container box styled with a group's colour (coloured border + title)."""
    return (f"rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor={stroke};"
            f"fontColor={font_color};verticalAlign=top;fontStyle=2;dashed=1;")


def to_drawio(graph, height, pos, edge_pts, color=True, theme="light"):
    nodes = graph["nodes"]
    # Absolute snapped rect for every placed node.
    rects = {}
    for node in nodes:
        nid = node["id"]
        if nid not in pos:
            continue
        w, h = node.get("width", DEFAULT_W), node.get("height", DEFAULT_H)
        xc, yc = pos[nid]
        x = snap(xc * 72 - w / 2)
        y = snap((height - yc) * 72 - h / 2)             # flip: dot origin is bottom-left
        rects[nid] = (x, y, w, h)
    # Parse the (possibly nested) group tree and assign each container a
    # collision-free id and a title (the path's last segment, or a member's groupLabel).
    gpath, direct, children, ordered = group_tree(nodes)
    # Assign each top-level group a palette colour, in order of first appearance.
    top_order = []
    for node in nodes:
        t = gpath.get(node["id"])
        if t and t[0] not in top_order:
            top_order.append(t[0])

    palette = PALETTE if theme == "light" else load_palette("dark")

    def gcolor(seg):
        return palette[top_order.index(seg) % len(palette)]

    used = {n["id"] for n in nodes}
    label_override = {}
    for node in nodes:
        if node["id"] in gpath and "groupLabel" in node:
            label_override.setdefault(gpath[node["id"]], str(node["groupLabel"]))
    gid, glabel = {}, {}
    for i, p in enumerate(ordered):
        cid = f"group_{i}"
        while cid in used:                               # never collide with a node id
            cid += "_"
        used.add(cid)
        gid[p] = cid
        glabel[p] = label_override.get(p, p[-1])
    # Container bounding box (members + nested children + uniform padding),
    # computed deepest-first so a parent can wrap its already-sized children.
    gbox = {}
    for p in sorted(ordered, key=len, reverse=True):
        xs = [(rects[m][0], rects[m][1], rects[m][0] + rects[m][2], rects[m][1] + rects[m][3])
              for m in direct.get(p, []) if m in rects]
        xs += [(gbox[c][0], gbox[c][1], gbox[c][0] + gbox[c][2], gbox[c][1] + gbox[c][3])
               for c in children.get(p, []) if c in gbox]
        if not xs:
            continue
        x0 = min(b[0] for b in xs) - GROUP_PAD
        y0 = min(b[1] for b in xs) - GROUP_PAD
        x1 = max(b[2] for b in xs) + GROUP_PAD
        y1 = max(b[3] for b in xs) + GROUP_PAD
        gbox[p] = (x0, y0, x1 - x0, y1 - y0)

    # Shift everything positive: a container's top padding can push its top edge
    # above the page origin. Only translates when something would be negative.
    absx = [r[0] for r in rects.values()] + [b[0] for b in gbox.values()]
    absy = [r[1] for r in rects.values()] + [b[1] for b in gbox.values()]
    dx = GROUP_PAD - min(absx) if absx and min(absx) < 0 else 0
    dy = GROUP_PAD - min(absy) if absy and min(absy) < 0 else 0

    def rebase(x, y, parent_path):
        """Absolute -> coordinates relative to parent_path's box (or shifted if top-level)."""
        if parent_path is None:
            return x + dx, y + dy, "1"
        px, py, _, _ = gbox[parent_path]
        return x - px, y - py, gid[parent_path]

    cells = []
    # Containers shallow-first so each parent precedes its children.
    for p in ordered:
        if p not in gbox:
            continue
        gx, gy, gw, gh = gbox[p]
        x, y, parent = rebase(gx, gy, p[:-1] if len(p) > 1 else None)
        gstyle = (group_style(gcolor(p[0])[1], gcolor(p[0])[2] or "#94a3b8") if theme == "dark"
                  else group_style(gcolor(p[0])[1])) if color else (GROUP_STYLE_DARK if theme == "dark" else GROUP_STYLE_LIGHT)
        cells.append(
            f'        <mxCell id="{attr(gid[p])}" value="{attr(glabel[p])}" '
            f'style="{gstyle}" vertex="1" parent="{attr(parent)}">\n'
            f'          <mxGeometry x="{x}" y="{y}" width="{gw}" height="{gh}" as="geometry"/>\n'
            f"        </mxCell>"
        )
    for node in nodes:
        nid = node["id"]
        if nid not in rects:
            continue
        rx, ry, w, h = rects[nid]
        x, y, parent = rebase(rx, ry, gpath.get(nid) if gpath.get(nid) in gbox else None)
        if node.get("style"):
            style = node["style"]                         # explicit style always wins
        elif color and nid in gpath:
            fill, stroke, fcolor = gcolor(gpath[nid][0])   # tint styleless nodes by group
            fc = f";fontColor={fcolor}" if fcolor else ""
            style = f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};{fc}"
        else:
            style = NODE_STYLE_DARK if theme == "dark" else NODE_STYLE_LIGHT
        cells.append(
            f'        <mxCell id="{attr(nid)}" value="{attr(node.get("label", nid))}" '
            f'style="{attr(style)}" vertex="1" parent="{attr(parent)}">\n'
            f'          <mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/>\n'
            f"        </mxCell>"
        )
    for i, edge in enumerate(graph.get("edges", [])):
        src, dst = edge["source"], edge["target"]
        full_pts = edge_pts.get((src, dst), [])
        # Pin the entry/exit connection points so draw.io's orthogonal router
        # starts and ends exactly where Graphviz computed the route, instead of
        # guessing a free-floating point and producing kinked/overlapping edges.
        # draw.io's exitX/entryX/Y are ratios (0.0–1.0) of the node's width/height;
        # clamp to [0,1] and round to 2dp to avoid drawing artefacts.
        exit_attrs = entry_attrs = ""
        if len(full_pts) >= 2 and src in rects and dst in rects:
            sx, sy = full_pts[0]
            tx, ty = full_pts[-1]
            sxr, syr, sw, sh = rects[src]
            txr, tyr, tw, th = rects[dst]
            # Graphviz point -> ratio relative to the node's bounding rect.
            ex = clamp_ratio((sx * 72 - sxr) / sw)
            ey = clamp_ratio((sy * 72 - syr) / sh) * -1  # flip Y (drawio top-left)
            enx = clamp_ratio((tx * 72 - txr) / tw)
            eny = clamp_ratio((ty * 72 - tyr) / th) * -1
            exit_attrs = f"exitX={ex};exitY={ey};exitDx=0;exitDy=0;"
            entry_attrs = f"entryX={enx};entryY={eny};entryDx=0;entryDy=0;"
        # Drop the first/last points (they sit on the node borders, where
        # draw.io attaches via exit/entry anchors) and replay interior bends.
        interior = full_pts[1:-1]
        if interior:
            points = "".join(
                f'<mxPoint x="{snap(x * 72) + dx}" y="{snap((height - y) * 72) + dy}"/>'
                for x, y in interior
            )
            geom = (f'<mxGeometry relative="1" as="geometry">'
                    f'<Array as="points">{points}</Array></mxGeometry>')
        else:
            geom = '<mxGeometry relative="1" as="geometry"/>'
        style = EDGE_STYLE + exit_attrs + entry_attrs
        cells.append(
            f'        <mxCell id="e{i}" value="{attr(edge.get("label", ""))}" '
            f'style="{style}" edge="1" parent="1" '
            f'source="{attr(src)}" target="{attr(dst)}">\n'
            f"          {geom}\n"
            f"        </mxCell>"
        )
    return (
        '<mxfile>\n  <diagram id="autolayout" name="Page-1">\n'
        '    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" '
        'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        'pageWidth="850" pageHeight="1100" math="0" shadow="0">\n'
        "      <root>\n"
        '        <mxCell id="0"/>\n'
        '        <mxCell id="1" parent="0"/>\n'
        + "\n".join(cells)
        + "\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n"
    )


def main():
    ap = argparse.ArgumentParser(description="Auto-layout a graph JSON into draw.io XML.")
    ap.add_argument("input", help="graph JSON file")
    ap.add_argument("-o", "--output", help="output .drawio path (default: stdout)")
    ap.add_argument("--mono", action="store_true",
                    help="don't colour groups by palette (monochrome boxes)")
    ap.add_argument("--theme", choices=["light", "dark"], default="light",
                    help="colour palette theme (default: light). dark uses paletteDark "
                         "from default.json to match a dark page background.")
    args = ap.parse_args()
    with open(args.input, encoding="utf-8") as f:
        graph = json.load(f)
    height, pos, edge_pts = layout(build_dot(graph))
    xml = to_drawio(graph, height, pos, edge_pts, color=not args.mono, theme=args.theme)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(xml)
        print(f"wrote {args.output} ({len(graph['nodes'])} nodes, "
              f"{len(graph.get('edges', []))} edges)", file=sys.stderr)
    else:
        sys.stdout.write(xml)


if __name__ == "__main__":
    main()
