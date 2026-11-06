"""Draws a flat illustration of the Rindergulasch with Hokkaido and Tagliatelle as SVG."""
import math
import random

random.seed(7)
W = H = 1200
CX, CY = 600, 640  # bowl centre
RX, RY = 400, 270  # food surface ellipse


def inside(x, y, rx=RX * 0.9, ry=RY * 0.86, cx=CX, cy=CY - 20):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1


parts = []
add = parts.append

add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add("""<defs>
  <radialGradient id="bg" cx="50%" cy="40%" r="75%">
    <stop offset="0" stop-color="#3b4a5e"/><stop offset="1" stop-color="#1c2533"/>
  </radialGradient>
  <linearGradient id="table" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7a4b2c"/><stop offset="1" stop-color="#5a341d"/>
  </linearGradient>
  <linearGradient id="bowlSide" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#b8462f"/><stop offset="0.45" stop-color="#d9603f"/>
    <stop offset="1" stop-color="#9c3824"/>
  </linearGradient>
  <radialGradient id="sauce" cx="45%" cy="40%" r="70%">
    <stop offset="0" stop-color="#9b3b1f"/><stop offset="1" stop-color="#6e2410"/>
  </radialGradient>
  <radialGradient id="meat" cx="35%" cy="30%" r="80%">
    <stop offset="0" stop-color="#7b3a22"/><stop offset="1" stop-color="#4a1f10"/>
  </radialGradient>
  <radialGradient id="pumpkin" cx="35%" cy="30%" r="80%">
    <stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#e57a16"/>
  </radialGradient>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur stdDeviation="18"/>
  </filter>
</defs>""")

# background: winter evening, wooden table
add(f'<rect width="{W}" height="{H}" fill="url(#bg)"/>')
for _ in range(70):  # snowflakes
    x, y, r = random.uniform(0, W), random.uniform(0, 520), random.uniform(2, 6)
    add(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="#ffffff" opacity="{random.uniform(.25,.7):.2f}"/>')
add(f'<rect y="560" width="{W}" height="{H-560}" fill="url(#table)"/>')
for i in range(7):  # wood grain
    y = 600 + i * 85 + random.uniform(-10, 10)
    add(f'<path d="M0 {y:.0f} C 300 {y-18:.0f}, 800 {y+22:.0f}, {W} {y-6:.0f}" stroke="#4a2a16" '
        f'stroke-width="3" fill="none" opacity="0.35"/>')

# linen napkin and fork (right)
add('<path d="M905 820 L1150 760 L1190 1010 L940 1075 Z" fill="#efe6d8"/>')
add('<path d="M905 820 L1150 760" stroke="#c9534a" stroke-width="10" opacity="0.8"/>'
    '<path d="M925 845 L1155 788" stroke="#c9534a" stroke-width="5" opacity="0.6"/>')
add('<g transform="rotate(-14 1060 920)">'
    '<rect x="1052" y="840" width="16" height="190" rx="8" fill="#c7ccd3"/>'
    '<rect x="1036" y="770" width="48" height="80" rx="14" fill="#c7ccd3"/>'
    + "".join(f'<rect x="{1036+i*14}" y="730" width="8" height="60" rx="4" fill="#c7ccd3"/>' for i in range(4))
    + '</g>')

# bowl shadow and body
add(f'<ellipse cx="{CX}" cy="{CY+250}" rx="420" ry="70" fill="#000" opacity="0.35" filter="url(#soft)"/>')
add(f'<path d="M{CX-440} {CY} C {CX-430} {CY+260}, {CX-200} {CY+330}, {CX} {CY+330} '
    f'C {CX+200} {CY+330}, {CX+430} {CY+260}, {CX+440} {CY} Z" fill="url(#bowlSide)"/>')
add(f'<ellipse cx="{CX}" cy="{CY}" rx="440" ry="300" fill="#f3ece2"/>')  # rim
add(f'<ellipse cx="{CX}" cy="{CY+6}" rx="{RX+12}" ry="{RY+12}" fill="#d8cfc2"/>')
add(f'<ellipse cx="{CX}" cy="{CY}" rx="{RX}" ry="{RY}" fill="url(#sauce)"/>')

# tagliatelle nest on the left third
NX, NY = CX - 215, CY - 5  # nest centre
for i in range(34):
    # long ribbons looping around the nest centre
    a0 = random.uniform(0, 2 * math.pi)
    sweep = random.uniform(1.6, 2.8)
    r0, r1 = random.uniform(40, 120), random.uniform(40, 120)
    pts = []
    for t in range(4):
        a = a0 + sweep * t / 3
        r = r0 + (r1 - r0) * t / 3
        pts.append((NX + r * math.cos(a), NY + r * 0.72 * math.sin(a)))
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = pts
    shade = random.choice(["#f4cf6b", "#efc35a", "#f7d880", "#e8b84c", "#f1c765"])
    add(f'<path d="M{x0:.0f} {y0:.0f} C {x1:.0f} {y1:.0f}, {x2:.0f} {y2:.0f}, {x3:.0f} {y3:.0f}" '
        f'stroke="#c9952f" stroke-width="27" stroke-linecap="round" fill="none" opacity="0.55"/>')
    add(f'<path d="M{x0:.0f} {y0:.0f} C {x1:.0f} {y1:.0f}, {x2:.0f} {y2:.0f}, {x3:.0f} {y3:.0f}" '
        f'stroke="{shade}" stroke-width="22" stroke-linecap="round" fill="none"/>')


def placed(n, min_dist, region):
    pts = []
    tries = 0
    while len(pts) < n and tries < 5000:
        tries += 1
        x, y = random.uniform(CX - RX, CX + RX), random.uniform(CY - RY, CY + RY)
        if not inside(x, y) or not region(x, y):
            continue
        if all(math.hypot(x - px, y - py) > min_dist for px, py in pts + taken):
            pts.append((x, y))
    taken.extend(pts)
    return pts


taken = []
right = lambda x, y: x > CX - 30  # gulasch side

for x, y in placed(11, 68, right):  # beef cubes
    s, rot = random.uniform(54, 70), random.uniform(-25, 25)
    add(f'<rect x="{x-s/2:.0f}" y="{y-s/2:.0f}" width="{s:.0f}" height="{s*0.85:.0f}" rx="14" '
        f'fill="url(#meat)" transform="rotate({rot:.0f} {x:.0f} {y:.0f})"/>')
for x, y in placed(9, 58, right):  # pumpkin cubes with green skin edge
    s, rot = random.uniform(44, 54), random.uniform(-30, 30)
    add(f'<g transform="rotate({rot:.0f} {x:.0f} {y:.0f})">'
        f'<rect x="{x-s/2:.0f}" y="{y-s/2:.0f}" width="{s:.0f}" height="{s:.0f}" rx="9" fill="url(#pumpkin)"/>'
        f'<rect x="{x-s/2:.0f}" y="{y+s/2-9:.0f}" width="{s:.0f}" height="9" rx="4" fill="#c4691a"/></g>')
for x, y in placed(10, 42, right):  # carrot slices
    r = random.uniform(16, 21)
    add(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.0f}" fill="#f28b2b"/>'
        f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r*0.45:.0f}" fill="#f7a64e"/>')

# sour cream dollop and parsley
sx, sy = CX + 70, CY - 60
add(f'<path d="M{sx-70} {sy+20} C {sx-80} {sy-30}, {sx-20} {sy-60}, {sx+10} {sy-40} '
    f'C {sx+50} {sy-70}, {sx+95} {sy-25}, {sx+75} {sy+15} C {sx+60} {sy+45}, {sx-55} {sy+50}, {sx-70} {sy+20} Z" '
    f'fill="#fbf8f2"/>')
add(f'<path d="M{sx-30} {sy-25} C {sx-10} {sy-40}, {sx+20} {sy-38}, {sx+35} {sy-20}" stroke="#ffffff" '
    f'stroke-width="8" stroke-linecap="round" fill="none"/>')
for _ in range(26):
    x, y = random.uniform(CX - 320, CX + 330), random.uniform(CY - 200, CY + 190)
    if not inside(x, y):
        continue
    rot, s = random.uniform(0, 360), random.uniform(9, 15)
    add(f'<ellipse cx="{x:.0f}" cy="{y:.0f}" rx="{s:.0f}" ry="{s*0.55:.0f}" fill="#3f9b3a" '
        f'transform="rotate({rot:.0f} {x:.0f} {y:.0f})"/>')

# steam
for dx in (-120, 10, 140):
    add(f'<path d="M{CX+dx} {CY-300} C {CX+dx-40} {CY-360}, {CX+dx+40} {CY-410}, {CX+dx} {CY-470}" '
        f'stroke="#ffffff" stroke-width="14" stroke-linecap="round" fill="none" opacity="0.28"/>')

add("</svg>")
open("/home/claude/recipe-image/gulasch.svg", "w").write("\n".join(parts))
print("svg written")
