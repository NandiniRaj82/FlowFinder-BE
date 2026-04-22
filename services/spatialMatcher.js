'use strict';

/**
 * spatialMatcher.js — The Universal Spatial Tree + IoU Matcher Engine
 * Phases 2 & 3 of the Hybrid Comparison Architecture
 */

/* ─── Color helpers ──────────────────────────────────────────────────────── */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function cssColorToHex(css) {
  if (!css || css === 'transparent' || css.includes('rgba(0, 0, 0, 0)')) return null;
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? rgbToHex(+m[1], +m[2], +m[3]) : null;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// CIE76 ΔE approximation for perceptual color distance
function colorDeltaE(hex1, hex2) {
  try {
    const [r1, g1, b1] = hexToRgb(hex1);
    const [r2, g2, b2] = hexToRgb(hex2);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  } catch { return 0; }
}

/* ─── Phase 2: Normalize Figma nodes → Spatial Elements ──────────────── */
function classifyFigmaType(node) {
  const t = (node.type || '').toUpperCase();
  if (t === 'TEXT') return 'text';
  if (t === 'RECTANGLE' || t === 'ELLIPSE' || t === 'LINE' || t === 'STAR' || t === 'POLYGON') return 'shape';
  if (t === 'VECTOR' || t === 'BOOLEAN_OPERATION') return 'icon';
  const name = (node.name || '').toLowerCase();
  if (name.includes('button') || name.includes('btn') || name.includes('cta')) return 'button';
  if (name.includes('input') || name.includes('field') || name.includes('search')) return 'input';
  if (name.includes('image') || name.includes('img') || name.includes('photo') || name.includes('avatar')) return 'image';
  if (['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(t)) return 'container';
  return 'shape';
}

function flattenFigmaToSpatialTree(node, frameOffset = { x: 0, y: 0 }, depth = 0) {
  const elements = [];
  if (!node || !node.absoluteBoundingBox) return elements;

  const box = node.absoluteBoundingBox;
  const bbox = {
    x: Math.round(box.x - frameOffset.x),
    y: Math.round(box.y - frameOffset.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };

  // Skip invisible or tiny elements
  if (bbox.width < 2 || bbox.height < 2) return elements;
  if (node.visible === false) return elements;

  const el = {
    source: 'figma',
    id: node.id,
    name: node.name || node.type,
    type: classifyFigmaType(node),
    bbox,
    visual: {},
    text: '',
    depth,
  };

  // Extract fills
  if (node.fills && Array.isArray(node.fills)) {
    const solidFill = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
    if (solidFill?.color) {
      const { r, g, b } = solidFill.color;
      el.visual.bgColor = rgbToHex(r * 255, g * 255, b * 255);
    }
  }

  // Extract strokes
  if (node.strokes && Array.isArray(node.strokes)) {
    const solidStroke = node.strokes.find(s => s.type === 'SOLID' && s.visible !== false);
    if (solidStroke?.color) {
      const { r, g, b } = solidStroke.color;
      el.visual.borderColor = rgbToHex(r * 255, g * 255, b * 255);
    }
  }
  if (node.strokeWeight) el.visual.borderWidth = node.strokeWeight;

  // Typography
  if (node.style) {
    el.visual.fontSize = node.style.fontSize;
    el.visual.fontWeight = node.style.fontWeight;
    el.visual.fontFamily = node.style.fontFamily;
    el.visual.lineHeight = node.style.lineHeightPx;
    el.visual.letterSpacing = node.style.letterSpacing;
  }

  // Text content
  if (node.type === 'TEXT' && node.characters) {
    el.text = node.characters;
  }

  // Corner radius
  if (node.cornerRadius != null) el.visual.borderRadius = node.cornerRadius;
  if (node.rectangleCornerRadii) el.visual.borderRadii = node.rectangleCornerRadii;

  // Opacity
  if (node.opacity != null && node.opacity < 1) el.visual.opacity = node.opacity;

  // Effects (shadows)
  if (node.effects) {
    const shadow = node.effects.find(e => e.type === 'DROP_SHADOW' && e.visible !== false);
    if (shadow) el.visual.hasShadow = true;
  }

  // Only push leaf nodes and meaningful containers
  const children = node.children || [];
  const isLeaf = children.length === 0;
  const isSmallContainer = el.type === 'container' && bbox.width < 600 && bbox.height < 200;
  const hasVisualProps = el.visual.bgColor || el.visual.borderColor || el.visual.borderRadius;

  if (isLeaf || (isSmallContainer && hasVisualProps) || el.type !== 'container') {
    elements.push(el);
  }

  // Recurse into children
  for (const child of children) {
    elements.push(...flattenFigmaToSpatialTree(child, frameOffset, depth + 1));
  }

  return elements;
}

/* ─── Phase 2: Normalize DOM elements → Spatial Elements ─────────────── */
function classifyDomType(el) {
  const tag = (el.tag || '').toLowerCase();
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'label', 'a'].includes(tag)) return 'text';
  if (['button'].includes(tag)) return 'button';
  if (['input', 'textarea', 'select'].includes(tag)) return 'input';
  if (['img', 'svg', 'video', 'canvas'].includes(tag)) return 'image';
  if (tag === 'svg' || tag === 'path') return 'icon';
  // Check role/class hints
  const cls = (el.classes || '').toLowerCase();
  if (cls.includes('btn') || cls.includes('button')) return 'button';
  if (cls.includes('icon')) return 'icon';
  return 'container';
}

function flattenDomToSpatialTree(domElements) {
  return domElements
    .filter(el => el.rect && el.rect.width >= 2 && el.rect.height >= 2)
    .map((el, i) => ({
      source: 'dom',
      id: el.id || el.dataTestId || `dom_${i}`,
      name: el.id || el.ariaLabel || el.classes?.split(' ')[0] || el.tag,
      type: classifyDomType(el),
      bbox: {
        x: Math.round(el.rect.x),
        y: Math.round(el.rect.y),
        width: Math.round(el.rect.width),
        height: Math.round(el.rect.height),
      },
      visual: {
        bgColor: cssColorToHex(el.styles?.backgroundColor),
        textColor: cssColorToHex(el.styles?.color),
        fontSize: parseFloat(el.styles?.fontSize) || null,
        fontWeight: parseInt(el.styles?.fontWeight) || null,
        fontFamily: el.styles?.fontFamily || null,
        lineHeight: el.styles?.lineHeight || null,
        borderRadius: parseFloat(el.styles?.borderRadius) || null,
        borderColor: cssColorToHex(el.styles?.borderColor),
        borderWidth: parseFloat(el.styles?.borderWidth) || null,
        hasShadow: el.styles?.boxShadow && el.styles.boxShadow !== 'none',
        opacity: parseFloat(el.styles?.opacity),
        padding: el.styles?.padding,
      },
      text: (el.text || '').trim().slice(0, 200),
      tag: el.tag,
      selector: el.selector || '',
    }));
}

/* ─── Phase 3: IoU Matcher Engine ────────────────────────────────────── */
function computeIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  if (x2 <= x1 || y2 <= y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;

  return union > 0 ? intersection / union : 0;
}

function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  // Jaccard on words
  const wordsA = new Set(na.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(nb.split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

function typeAffinity(a, b) {
  if (a === b) return 0.15;
  // Text elements can match with buttons (buttons often have text)
  if ((a === 'text' && b === 'button') || (a === 'button' && b === 'text')) return 0.05;
  return 0;
}

function matchElements(figmaElements, domElements) {
  const pairs = [];

  // Compute all pairwise scores
  for (const fig of figmaElements) {
    for (const dom of domElements) {
      const iou = computeIoU(fig.bbox, dom.bbox);
      const textSim = textSimilarity(fig.text, dom.text);
      const typeBonus = typeAffinity(fig.type, dom.type);

      // Combined score: IoU is primary, text is secondary, type is tertiary
      const score = iou * 0.55 + textSim * 0.35 + typeBonus;

      if (score > 0.08) {  // minimum threshold
        pairs.push({ figma: fig, dom, score, iou, textSim });
      }
    }
  }

  // Sort by score descending for greedy assignment
  pairs.sort((a, b) => b.score - a.score);

  const matchedFigma = new Set();
  const matchedDom = new Set();
  const matches = [];

  for (const pair of pairs) {
    if (matchedFigma.has(pair.figma.id) || matchedDom.has(pair.dom.id)) continue;
    matchedFigma.add(pair.figma.id);
    matchedDom.add(pair.dom.id);
    matches.push({
      figmaElement: pair.figma,
      domElement: pair.dom,
      matchScore: pair.score,
      iou: pair.iou,
      textSimilarity: pair.textSim,
      matchMethod: pair.iou > 0.3 ? (pair.textSim > 0.5 ? 'hybrid' : 'iou') : 'text',
    });
  }

  // Unmatched Figma elements = missing from DOM
  const missingFromDom = figmaElements
    .filter(f => !matchedFigma.has(f.id))
    .filter(f => f.type !== 'container')  // Don't flag containers as missing
    .map(f => ({
      figmaElement: f,
      domElement: null,
      matchScore: 0,
      matchMethod: 'none',
    }));

  // Unmatched DOM elements = extra in DOM (not in design)
  const extraInDom = domElements
    .filter(d => !matchedDom.has(d.id))
    .filter(d => d.type !== 'container')
    .map(d => ({
      figmaElement: null,
      domElement: d,
      matchScore: 0,
      matchMethod: 'none',
    }));

  return { matches, missingFromDom, extraInDom };
}

/* ─── Phase 4: Property Diffing Engine ───────────────────────────────── */
const THRESHOLDS = {
  colorDeltaE: 8,      // perceptual color distance
  fontSize: 2,         // px
  fontWeight: 100,      // weight units
  position: 6,          // px offset tolerance
  size: 8,              // px dimension tolerance
  borderRadius: 2,      // px
};

function diffMatchedPair(match) {
  const { figmaElement: fig, domElement: dom } = match;
  if (!fig || !dom) return [];

  const drifts = [];
  const pctBox = bboxToPercent(fig.bbox, dom.bbox);

  // ── Color diffs ──
  if (fig.visual.bgColor) {
    const domBg = dom.visual.bgColor;
    if (domBg && colorDeltaE(fig.visual.bgColor, domBg) > THRESHOLDS.colorDeltaE) {
      const delta = colorDeltaE(fig.visual.bgColor, domBg);
      drifts.push({
        category: 'color',
        severity: delta > 60 ? 'critical' : delta > 25 ? 'major' : 'minor',
        property: 'backgroundColor',
        title: `Background color mismatch — ${fig.name}`,
        description: `Background color differs between design and implementation.`,
        expected: fig.visual.bgColor,
        actual: domBg,
        delta: Math.round(delta),
        boundingBox: pctBox,
        figmaName: fig.name,
        domSelector: dom.selector,
      });
    }
  }

  // Text color
  if (fig.visual.bgColor && fig.type === 'text') {
    const domColor = dom.visual.textColor;
    if (domColor && fig.visual.bgColor) {
      const delta = colorDeltaE(fig.visual.bgColor, domColor);
      if (delta > THRESHOLDS.colorDeltaE) {
        drifts.push({
          category: 'color',
          severity: delta > 60 ? 'critical' : delta > 25 ? 'major' : 'minor',
          property: 'color',
          title: `Text color mismatch — ${fig.name}`,
          description: `Text color differs from the design specification.`,
          expected: fig.visual.bgColor,
          actual: domColor,
          delta: Math.round(delta),
          boundingBox: pctBox,
          figmaName: fig.name,
          domSelector: dom.selector,
        });
      }
    }
  }

  // ── Typography diffs ──
  if (fig.visual.fontSize && dom.visual.fontSize) {
    const diff = Math.abs(fig.visual.fontSize - dom.visual.fontSize);
    if (diff > THRESHOLDS.fontSize) {
      drifts.push({
        category: 'typography',
        severity: diff > 8 ? 'major' : 'minor',
        property: 'fontSize',
        title: `Font size mismatch — ${fig.name}`,
        description: `Font size: design specifies ${fig.visual.fontSize}px, site renders ${dom.visual.fontSize}px.`,
        expected: `${fig.visual.fontSize}px`,
        actual: `${dom.visual.fontSize}px`,
        delta: diff,
        boundingBox: pctBox,
        figmaName: fig.name,
        domSelector: dom.selector,
      });
    }
  }

  if (fig.visual.fontWeight && dom.visual.fontWeight) {
    const diff = Math.abs(fig.visual.fontWeight - dom.visual.fontWeight);
    if (diff >= THRESHOLDS.fontWeight) {
      drifts.push({
        category: 'typography',
        severity: 'minor',
        property: 'fontWeight',
        title: `Font weight mismatch — ${fig.name}`,
        description: `Font weight: design ${fig.visual.fontWeight}, site ${dom.visual.fontWeight}.`,
        expected: `${fig.visual.fontWeight}`,
        actual: `${dom.visual.fontWeight}`,
        delta: diff,
        boundingBox: pctBox,
        figmaName: fig.name,
        domSelector: dom.selector,
      });
    }
  }

  // ── Spacing / Position diffs ──
  const dx = Math.abs(fig.bbox.x - dom.bbox.x);
  const dy = Math.abs(fig.bbox.y - dom.bbox.y);
  if (dx > THRESHOLDS.position || dy > THRESHOLDS.position) {
    drifts.push({
      category: 'spacing',
      severity: (dx > 20 || dy > 20) ? 'major' : 'minor',
      property: 'position',
      title: `Position offset — ${fig.name}`,
      description: `Element is shifted ${dx}px horizontally and ${dy}px vertically from its design position.`,
      expected: `(${fig.bbox.x}, ${fig.bbox.y})`,
      actual: `(${dom.bbox.x}, ${dom.bbox.y})`,
      delta: Math.round(Math.hypot(dx, dy)),
      boundingBox: pctBox,
      figmaName: fig.name,
      domSelector: dom.selector,
    });
  }

  // Size diff
  const dw = Math.abs(fig.bbox.width - dom.bbox.width);
  const dh = Math.abs(fig.bbox.height - dom.bbox.height);
  if (dw > THRESHOLDS.size || dh > THRESHOLDS.size) {
    drifts.push({
      category: 'spacing',
      severity: (dw > 30 || dh > 30) ? 'major' : 'minor',
      property: 'dimensions',
      title: `Size mismatch — ${fig.name}`,
      description: `Element dimensions differ: design ${fig.bbox.width}×${fig.bbox.height}px, site ${dom.bbox.width}×${dom.bbox.height}px.`,
      expected: `${fig.bbox.width}×${fig.bbox.height}px`,
      actual: `${dom.bbox.width}×${dom.bbox.height}px`,
      delta: Math.round(Math.hypot(dw, dh)),
      boundingBox: pctBox,
      figmaName: fig.name,
      domSelector: dom.selector,
    });
  }

  // ── Border radius ──
  if (fig.visual.borderRadius != null && dom.visual.borderRadius != null) {
    const diff = Math.abs(fig.visual.borderRadius - dom.visual.borderRadius);
    if (diff > THRESHOLDS.borderRadius) {
      drifts.push({
        category: 'border',
        severity: 'minor',
        property: 'borderRadius',
        title: `Border radius mismatch — ${fig.name}`,
        description: `Corner radius: design ${fig.visual.borderRadius}px, site ${dom.visual.borderRadius}px.`,
        expected: `${fig.visual.borderRadius}px`,
        actual: `${dom.visual.borderRadius}px`,
        delta: diff,
        boundingBox: pctBox,
        figmaName: fig.name,
        domSelector: dom.selector,
      });
    }
  }

  // ── Content / text diff ──
  if (fig.text && fig.text.length > 2) {
    const figText = fig.text.toLowerCase().trim();
    const domText = (dom.text || '').toLowerCase().trim();
    if (figText.length > 3 && !domText.includes(figText.slice(0, Math.min(30, figText.length)))) {
      drifts.push({
        category: 'content',
        severity: 'major',
        property: 'textContent',
        title: `Content mismatch — ${fig.name}`,
        description: `Text in design not found on live site.`,
        expected: `"${fig.text.slice(0, 80)}"`,
        actual: `"${(dom.text || '(empty)').slice(0, 80)}"`,
        delta: 0,
        boundingBox: pctBox,
        figmaName: fig.name,
        domSelector: dom.selector,
      });
    }
  }

  // ── Shadow presence ──
  if (fig.visual.hasShadow && !dom.visual.hasShadow) {
    drifts.push({
      category: 'border',
      severity: 'minor',
      property: 'boxShadow',
      title: `Missing shadow — ${fig.name}`,
      description: `Design specifies a drop shadow, but none found on the live element.`,
      expected: 'Drop shadow',
      actual: 'No shadow',
      delta: 0,
      boundingBox: pctBox,
      figmaName: fig.name,
      domSelector: dom.selector,
    });
  }

  return drifts;
}

function bboxToPercent(figBbox, domBbox) {
  // Use figma bbox for overlay positioning — percentage of viewport
  const VIEWPORT_W = 1440;  // will be overridden by actual frame width
  const VIEWPORT_H = 900;   // will be overridden
  const box = figBbox || domBbox;
  return {
    x: Math.max(0, Math.round((box.x / VIEWPORT_W) * 100)),
    y: Math.max(0, Math.round((box.y / VIEWPORT_H) * 100)),
    width: Math.min(100, Math.max(2, Math.round((box.width / VIEWPORT_W) * 100))),
    height: Math.min(90, Math.max(1, Math.round((box.height / VIEWPORT_H) * 100))),
  };
}

function bboxToPercentWithDimensions(figBbox, domBbox, viewW, viewH) {
  const box = figBbox || domBbox;
  return {
    x: Math.max(0, Math.round((box.x / viewW) * 100)),
    y: Math.max(0, Math.round((box.y / viewH) * 100)),
    width: Math.min(100, Math.max(2, Math.round((box.width / viewW) * 100))),
    height: Math.min(90, Math.max(1, Math.round((box.height / viewH) * 100))),
  };
}

/* ─── Full pipeline: run all phases ──────────────────────────────────── */
function runSpatialComparison(figmaNodes, domElements, frameWidth, frameHeight) {
  // Phase 2: Build spatial trees
  const figRoot = figmaNodes;
  const frameOffset = figRoot.absoluteBoundingBox
    ? { x: figRoot.absoluteBoundingBox.x, y: figRoot.absoluteBoundingBox.y }
    : { x: 0, y: 0 };

  const figmaElements = flattenFigmaToSpatialTree(figRoot, frameOffset);
  const domSpatialElements = flattenDomToSpatialTree(domElements);

  console.log(`[SpatialMatcher] Figma elements: ${figmaElements.length}, DOM elements: ${domSpatialElements.length}`);

  // Phase 3: Match
  const { matches, missingFromDom, extraInDom } = matchElements(figmaElements, domSpatialElements);
  console.log(`[SpatialMatcher] Matches: ${matches.length}, Missing: ${missingFromDom.length}, Extra: ${extraInDom.length}`);

  // Phase 4: Diff matched pairs
  const allDrifts = [];
  let issueNum = 1;

  for (const match of matches) {
    const drifts = diffMatchedPair(match);
    for (const d of drifts) {
      d.boundingBox = bboxToPercentWithDimensions(
        match.figmaElement?.bbox, match.domElement?.bbox, frameWidth, frameHeight
      );
      d.issueNumber = issueNum++;
      d.matchConfidence = Math.round(match.matchScore * 100);
      allDrifts.push(d);
    }
  }

  // Missing elements → drifts
  for (const miss of missingFromDom.slice(0, 15)) {
    allDrifts.push({
      issueNumber: issueNum++,
      category: 'missing',
      severity: miss.figmaElement.type === 'text' ? 'major' : 'minor',
      property: 'element',
      title: `Missing element — ${miss.figmaElement.name}`,
      description: `This ${miss.figmaElement.type} element exists in the Figma design but was not found on the live site.`,
      expected: miss.figmaElement.name,
      actual: '(not found)',
      delta: 0,
      boundingBox: bboxToPercentWithDimensions(miss.figmaElement.bbox, null, frameWidth, frameHeight),
      figmaName: miss.figmaElement.name,
      domSelector: '',
      matchConfidence: 0,
    });
  }

  // Compute overall scores
  const totalChecks = matches.length + missingFromDom.length;
  const matchedWell = matches.filter(m => m.matchScore > 0.5).length;
  const spatialMatchPct = totalChecks > 0 ? Math.round((matchedWell / totalChecks) * 100) : 0;

  // Severity breakdown
  const critCount = allDrifts.filter(d => d.severity === 'critical').length;
  const majCount = allDrifts.filter(d => d.severity === 'major').length;
  const minCount = allDrifts.filter(d => d.severity === 'minor').length;

  // Weighted score
  const driftPenalty = Math.min(60, critCount * 8 + majCount * 4 + minCount * 1);
  const structuralScore = spatialMatchPct;
  const overallScore = Math.max(0, Math.min(100, Math.round(structuralScore - driftPenalty)));

  return {
    drifts: allDrifts,
    stats: {
      figmaElementCount: figmaElements.length,
      domElementCount: domSpatialElements.length,
      matchedPairs: matches.length,
      missingElements: missingFromDom.length,
      extraElements: extraInDom.length,
      spatialMatchPct,
    },
    overallScore,
  };
}

module.exports = {
  flattenFigmaToSpatialTree,
  flattenDomToSpatialTree,
  matchElements,
  diffMatchedPair,
  computeIoU,
  textSimilarity,
  runSpatialComparison,
  colorDeltaE,
  cssColorToHex,
  rgbToHex,
  bboxToPercentWithDimensions,
};
