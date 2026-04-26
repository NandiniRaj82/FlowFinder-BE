'use strict';

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
function colorDeltaE(hex1, hex2) {
  try {
    const [r1, g1, b1] = hexToRgb(hex1);
    const [r2, g2, b2] = hexToRgb(hex2);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  } catch { return 0; }
}

/* ─── Phase 2: Figma spatial tree ────────────────────────────────────── */
function classifyFigmaType(node) {
  const t = (node.type || '').toUpperCase();
  if (t === 'TEXT') return 'text';
  if (['RECTANGLE','ELLIPSE','LINE','STAR','POLYGON'].includes(t)) return 'shape';
  if (['VECTOR','BOOLEAN_OPERATION'].includes(t)) return 'icon';
  const name = (node.name || '').toLowerCase();
  if (name.includes('button') || name.includes('btn') || name.includes('cta')) return 'button';
  if (name.includes('input') || name.includes('field') || name.includes('search')) return 'input';
  if (name.includes('image') || name.includes('img') || name.includes('photo') || name.includes('avatar')) return 'image';
  if (['FRAME','GROUP','COMPONENT','INSTANCE','COMPONENT_SET'].includes(t)) return 'container';
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
  if (bbox.width < 2 || bbox.height < 2) return elements;
  if (node.visible === false) return elements;

  const el = { source: 'figma', id: node.id, name: node.name || node.type, type: classifyFigmaType(node), bbox, visual: {}, text: '', depth };

  if (node.fills && Array.isArray(node.fills)) {
    const solidFill = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
    if (solidFill?.color) {
      const { r, g, b } = solidFill.color;
      el.visual.bgColor = rgbToHex(r * 255, g * 255, b * 255);
    }
  }
  if (node.strokes && Array.isArray(node.strokes)) {
    const s = node.strokes.find(s => s.type === 'SOLID' && s.visible !== false);
    if (s?.color) { const { r, g, b } = s.color; el.visual.borderColor = rgbToHex(r * 255, g * 255, b * 255); }
  }
  if (node.strokeWeight) el.visual.borderWidth = node.strokeWeight;
  if (node.style) {
    el.visual.fontSize = node.style.fontSize;
    el.visual.fontWeight = node.style.fontWeight;
    el.visual.fontFamily = node.style.fontFamily;
    el.visual.lineHeight = node.style.lineHeightPx;
  }
  if (node.type === 'TEXT' && node.characters) el.text = node.characters;
  if (node.cornerRadius != null) el.visual.borderRadius = node.cornerRadius;
  if (node.opacity != null && node.opacity < 1) el.visual.opacity = node.opacity;
  if (node.effects) {
    const shadow = node.effects.find(e => e.type === 'DROP_SHADOW' && e.visible !== false);
    if (shadow) el.visual.hasShadow = true;
  }

  const children = node.children || [];
  const isLeaf = children.length === 0;
  const isSmallContainer = el.type === 'container' && bbox.width < 600 && bbox.height < 200;
  const hasVisualProps = el.visual.bgColor || el.visual.borderColor || el.visual.borderRadius;
  if (isLeaf || (isSmallContainer && hasVisualProps) || el.type !== 'container') elements.push(el);
  for (const child of children) elements.push(...flattenFigmaToSpatialTree(child, frameOffset, depth + 1));
  return elements;
}

/* ─── Phase 2: DOM spatial tree ──────────────────────────────────────── */
function classifyDomType(el) {
  const tag = (el.tag || '').toLowerCase();
  if (['h1','h2','h3','h4','h5','h6','p','span','label','a'].includes(tag)) return 'text';
  if (tag === 'button') return 'button';
  if (['input','textarea','select'].includes(tag)) return 'input';
  if (['img','svg','video','canvas'].includes(tag)) return 'image';
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
      bbox: { x: Math.round(el.rect.x), y: Math.round(el.rect.y), width: Math.round(el.rect.width), height: Math.round(el.rect.height) },
      visual: {
        bgColor: cssColorToHex(el.styles?.backgroundColor),
        textColor: cssColorToHex(el.styles?.color),
        fontSize: parseFloat(el.styles?.fontSize) || null,
        fontWeight: parseInt(el.styles?.fontWeight) || null,
        fontFamily: el.styles?.fontFamily || null,
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

/* ─── Phase 3: IoU Matcher ───────────────────────────────────────────── */
function computeIoU(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = a.toLowerCase().trim(), nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  const wordsA = new Set(na.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(nb.split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / (wordsA.size + wordsB.size - intersection);
}
function typeAffinity(a, b) {
  if (a === b) return 0.15;
  if ((a === 'text' && b === 'button') || (a === 'button' && b === 'text')) return 0.05;
  return 0;
}
function matchElements(figmaElements, domElements) {
  const pairs = [];
  for (const fig of figmaElements) {
    for (const dom of domElements) {
      const iou = computeIoU(fig.bbox, dom.bbox);
      const textSim = textSimilarity(fig.text, dom.text);
      const typeBonus = typeAffinity(fig.type, dom.type);
      const score = iou * 0.55 + textSim * 0.35 + typeBonus;
      if (score > 0.08) pairs.push({ figma: fig, dom, score, iou, textSim });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const matchedFigma = new Set(), matchedDom = new Set(), matches = [];
  for (const pair of pairs) {
    if (matchedFigma.has(pair.figma.id) || matchedDom.has(pair.dom.id)) continue;
    matchedFigma.add(pair.figma.id);
    matchedDom.add(pair.dom.id);
    matches.push({ figmaElement: pair.figma, domElement: pair.dom, matchScore: pair.score, iou: pair.iou, textSimilarity: pair.textSim, matchMethod: pair.iou > 0.3 ? (pair.textSim > 0.5 ? 'hybrid' : 'iou') : 'text' });
  }

  // Unmatched Figma = missing from DOM
  const missingFromDom = figmaElements
    .filter(f => !matchedFigma.has(f.id))
    .filter(f => f.type !== 'container')
    .map(f => ({ figmaElement: f, domElement: null, matchScore: 0, matchMethod: 'none' }));

  const extraInDom = domElements
    .filter(d => !matchedDom.has(d.id))
    .filter(d => d.type !== 'container')
    .map(d => ({ figmaElement: null, domElement: d, matchScore: 0, matchMethod: 'none' }));

  return { matches, missingFromDom, extraInDom };
}

/* ─── Phase 4: Property Diffing — Raised Thresholds ─────────────────── */
const THRESHOLDS = {
  colorDeltaE: 15,  // was 8  — browser rendering differences, alpha blending
  fontSize:     4,  // was 2  — Figma uses fractional px, browsers round
  fontWeight:  200, // was 100 — only flag normal→bold level changes
  position:    20,  // was 6  — browser rendering routinely shifts 10-20px
  size:        25,  // was 8  — text/containers vary naturally
  borderRadius: 4,  // was 2  — sub-pixel rounding
  minElementArea: 400, // NEW — skip tiny elements (< ~20×20px) for pos/size checks
};

function diffMatchedPair(match) {
  const { figmaElement: fig, domElement: dom } = match;
  if (!fig || !dom) return [];
  const drifts = [];
  const pctBox = bboxToPercent(fig.bbox, dom.bbox);
  const figArea = fig.bbox.width * fig.bbox.height;

  // ── Color ──
  if (fig.visual.bgColor) {
    const domBg = dom.visual.bgColor;
    if (domBg) {
      const delta = colorDeltaE(fig.visual.bgColor, domBg);
      if (delta > THRESHOLDS.colorDeltaE) {
        drifts.push({ category: 'color', severity: delta > 60 ? 'critical' : delta > 30 ? 'major' : 'minor', property: 'backgroundColor', title: `Background color mismatch — ${fig.name}`, description: `Background color differs between design and implementation.`, expected: fig.visual.bgColor, actual: domBg, delta: Math.round(delta), boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
      }
    }
  }

  // Text color (only when Figma has explicit text color via bgColor on a text node)
  if (fig.visual.bgColor && fig.type === 'text') {
    const domColor = dom.visual.textColor;
    if (domColor) {
      const delta = colorDeltaE(fig.visual.bgColor, domColor);
      if (delta > THRESHOLDS.colorDeltaE) {
        drifts.push({ category: 'color', severity: delta > 60 ? 'critical' : delta > 30 ? 'major' : 'minor', property: 'color', title: `Text color mismatch — ${fig.name}`, description: `Text color differs from the design specification.`, expected: fig.visual.bgColor, actual: domColor, delta: Math.round(delta), boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
      }
    }
  }

  // ── Typography ──
  if (fig.visual.fontSize && dom.visual.fontSize) {
    const diff = Math.abs(fig.visual.fontSize - dom.visual.fontSize);
    if (diff > THRESHOLDS.fontSize) {
      drifts.push({ category: 'typography', severity: diff > 10 ? 'major' : 'minor', property: 'fontSize', title: `Font size mismatch — ${fig.name}`, description: `Font size: design ${fig.visual.fontSize}px, site ${dom.visual.fontSize}px.`, expected: `${fig.visual.fontSize}px`, actual: `${dom.visual.fontSize}px`, delta: diff, boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
    }
  }
  if (fig.visual.fontWeight && dom.visual.fontWeight) {
    const diff = Math.abs(fig.visual.fontWeight - dom.visual.fontWeight);
    if (diff >= THRESHOLDS.fontWeight) {
      drifts.push({ category: 'typography', severity: 'minor', property: 'fontWeight', title: `Font weight mismatch — ${fig.name}`, description: `Font weight: design ${fig.visual.fontWeight}, site ${dom.visual.fontWeight}.`, expected: `${fig.visual.fontWeight}`, actual: `${dom.visual.fontWeight}`, delta: diff, boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
    }
  }

  // ── Position — only for non-tiny elements ──
  if (figArea >= THRESHOLDS.minElementArea) {
    const dx = Math.abs(fig.bbox.x - dom.bbox.x);
    const dy = Math.abs(fig.bbox.y - dom.bbox.y);
    if (dx > THRESHOLDS.position || dy > THRESHOLDS.position) {
      drifts.push({ category: 'spacing', severity: (dx > 50 || dy > 50) ? 'major' : 'minor', property: 'position', title: `Position offset — ${fig.name}`, description: `Element shifted ${dx}px H / ${dy}px V from design position.`, expected: `(${fig.bbox.x}, ${fig.bbox.y})`, actual: `(${dom.bbox.x}, ${dom.bbox.y})`, delta: Math.round(Math.hypot(dx, dy)), boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
    }
  }

  // ── Size — only for non-tiny elements ──
  if (figArea >= THRESHOLDS.minElementArea) {
    const dw = Math.abs(fig.bbox.width - dom.bbox.width);
    const dh = Math.abs(fig.bbox.height - dom.bbox.height);
    if (dw > THRESHOLDS.size || dh > THRESHOLDS.size) {
      drifts.push({ category: 'spacing', severity: (dw > 60 || dh > 60) ? 'major' : 'minor', property: 'dimensions', title: `Size mismatch — ${fig.name}`, description: `Dimensions: design ${fig.bbox.width}×${fig.bbox.height}px, site ${dom.bbox.width}×${dom.bbox.height}px.`, expected: `${fig.bbox.width}×${fig.bbox.height}px`, actual: `${dom.bbox.width}×${dom.bbox.height}px`, delta: Math.round(Math.hypot(dw, dh)), boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
    }
  }

  // ── Border radius ──
  if (fig.visual.borderRadius != null && dom.visual.borderRadius != null) {
    const diff = Math.abs(fig.visual.borderRadius - dom.visual.borderRadius);
    if (diff > THRESHOLDS.borderRadius) {
      drifts.push({ category: 'border', severity: 'minor', property: 'borderRadius', title: `Border radius mismatch — ${fig.name}`, description: `Corner radius: design ${fig.visual.borderRadius}px, site ${dom.visual.borderRadius}px.`, expected: `${fig.visual.borderRadius}px`, actual: `${dom.visual.borderRadius}px`, delta: diff, boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
    }
  }

  // ── Text content ──
  if (fig.text && fig.text.length > 2) {
    const figText = fig.text.toLowerCase().trim();
    const domText = (dom.text || '').toLowerCase().trim();
    if (figText.length > 3 && !domText.includes(figText.slice(0, Math.min(30, figText.length)))) {
      drifts.push({ category: 'content', severity: 'major', property: 'textContent', title: `Content mismatch — ${fig.name}`, description: `Text in design not found on live site.`, expected: `"${fig.text.slice(0, 80)}"`, actual: `"${(dom.text || '(empty)').slice(0, 80)}"`, delta: 0, boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
    }
  }

  // ── Shadow ──
  if (fig.visual.hasShadow && !dom.visual.hasShadow) {
    drifts.push({ category: 'border', severity: 'minor', property: 'boxShadow', title: `Missing shadow — ${fig.name}`, description: `Design specifies a drop shadow, but none found on live element.`, expected: 'Drop shadow', actual: 'No shadow', delta: 0, boundingBox: pctBox, figmaName: fig.name, domSelector: dom.selector });
  }

  return drifts;
}

function bboxToPercent(figBbox, domBbox) {
  const VIEWPORT_W = 1440, VIEWPORT_H = 900;
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

/* ─── Deduplication: merge noisy multi-drift elements ────────────────── */
const SEVERITY_RANK = { critical: 3, major: 2, minor: 1 };

function deduplicateDrifts(drifts) {
  // Group by figmaName
  const byElement = new Map();
  for (const d of drifts) {
    const key = d.figmaName || d.domSelector || 'unknown';
    if (!byElement.has(key)) byElement.set(key, []);
    byElement.get(key).push(d);
  }

  const result = [];
  for (const [, group] of byElement) {
    // Sort by severity within group
    group.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

    if (group.length <= 2) {
      result.push(...group);
    } else {
      // Keep top 2 findings per element (most severe), merge rest into one
      result.push(group[0]);
      if (group.length === 2) {
        result.push(group[1]);
      } else {
        // Summarise remaining as a compound finding
        const remaining = group.slice(1);
        const categories = [...new Set(remaining.map(d => d.category))].join(', ');
        const topSeverity = remaining[0].severity;
        result.push({
          ...remaining[0],
          title: `Multiple style issues — ${remaining[0].figmaName}`,
          description: `${remaining.length} additional differences (${categories}). Review element styling carefully.`,
          severity: topSeverity,
          delta: Math.max(...remaining.map(d => d.delta || 0)),
        });
      }
    }
  }

  // Sort final list: critical → major → minor, then by delta
  result.sort((a, b) => {
    const sr = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    return sr !== 0 ? sr : (b.delta || 0) - (a.delta || 0);
  });

  return result;
}

/* ─── Figma grouping node names to skip for "missing" ───────────────── */
const SKIP_MISSING_RE = /^(frame|group|auto\s*layout|component|instance|vector|rectangle|ellipse|line|polygon|star|boolean|layer|shape|container)\s*\d*$/i;

/* ─── Full pipeline ───────────────────────────────────────────────────── */
function runSpatialComparison(figmaNodes, domElements, frameWidth, frameHeight) {
  const figRoot = figmaNodes;
  const frameOffset = figRoot.absoluteBoundingBox
    ? { x: figRoot.absoluteBoundingBox.x, y: figRoot.absoluteBoundingBox.y }
    : { x: 0, y: 0 };

  const figmaElements = flattenFigmaToSpatialTree(figRoot, frameOffset);
  const domSpatialElements = flattenDomToSpatialTree(domElements);
  console.log(`[SpatialMatcher] Figma elements: ${figmaElements.length}, DOM elements: ${domSpatialElements.length}`);

  const { matches, missingFromDom, extraInDom } = matchElements(figmaElements, domSpatialElements);
  console.log(`[SpatialMatcher] Matches: ${matches.length}, Missing: ${missingFromDom.length}, Extra: ${extraInDom.length}`);

  // Phase 4: Diff matched pairs
  const rawDrifts = [];
  for (const match of matches) {
    const drifts = diffMatchedPair(match);
    for (const d of drifts) {
      d.boundingBox = bboxToPercentWithDimensions(match.figmaElement?.bbox, match.domElement?.bbox, frameWidth, frameHeight);
      d.matchConfidence = Math.round(match.matchScore * 100);
      rawDrifts.push(d);
    }
  }

  // Missing elements — strict filter: must be real content, not internal grouping
  const meaningfulMissing = missingFromDom
    .filter(m => !SKIP_MISSING_RE.test((m.figmaElement.name || '').trim()))
    .filter(m => {
      const f = m.figmaElement;
      const area = f.bbox.width * f.bbox.height;
      return area >= 2000 && (f.text || f.visual.bgColor || f.visual.borderColor);
    })
    .slice(0, 8); // cap at 8

  let issueNum = 1;
  for (const miss of meaningfulMissing) {
    rawDrifts.push({
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

  // Deduplicate and sort
  const allDrifts = deduplicateDrifts(rawDrifts);

  // Re-number after dedup
  allDrifts.forEach((d, i) => { d.issueNumber = i + 1; });

  // Score
  const totalChecks = matches.length + missingFromDom.length;
  const matchedWell = matches.filter(m => m.matchScore > 0.5).length;
  const spatialMatchPct = totalChecks > 0 ? Math.round((matchedWell / totalChecks) * 100) : 0;

  const critCount = allDrifts.filter(d => d.severity === 'critical').length;
  const majCount  = allDrifts.filter(d => d.severity === 'major').length;
  const minCount  = allDrifts.filter(d => d.severity === 'minor').length;

  const driftPenalty = Math.min(60, critCount * 8 + majCount * 4 + minCount * 1);
  const overallScore = Math.max(0, Math.min(100, Math.round(spatialMatchPct - driftPenalty)));

  return {
    drifts: allDrifts,
    stats: { figmaElementCount: figmaElements.length, domElementCount: domSpatialElements.length, matchedPairs: matches.length, missingElements: missingFromDom.length, extraElements: extraInDom.length, spatialMatchPct },
    overallScore,
  };
}

module.exports = { flattenFigmaToSpatialTree, flattenDomToSpatialTree, matchElements, diffMatchedPair, computeIoU, textSimilarity, runSpatialComparison, colorDeltaE, cssColorToHex, rgbToHex, bboxToPercentWithDimensions };
