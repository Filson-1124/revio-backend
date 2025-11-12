
import JSZip from "jszip";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  preserveOrder: false,
});

export async function extractPptxXml(filePath) {
  try {
    //Load PPTX as ZIP
    const data = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(data);

    const slideFiles = Object.keys(zip.files).filter((f) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(f)
    );

    const notesFiles = Object.keys(zip.files).filter((f) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)
    );

    const chartFiles = Object.keys(zip.files).filter((f) =>
      /^ppt\/charts\/chart\d+\.xml$/.test(f)
    );

    const slides = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const slideContent = await zip.files[slideFiles[i]].async("text");
      const slideXml = parser.parse(slideContent);

      // Extract main slide text
      const text = extractSlideText(slideXml);

      // Extract SmartArt text (fallback)
      let smartArt = extractSmartArt(slideXml);

      const slideRelsPath = `ppt/slides/_rels/slide${i + 1}.xml.rels`;

      if (zip.files[slideRelsPath]) {
        const relsContent = await zip.files[slideRelsPath].async("text");
        const relsXml = parser.parse(relsContent);

        const relationships = relsXml.Relationships?.Relationship
          ? Array.isArray(relsXml.Relationships.Relationship)
            ? relsXml.Relationships.Relationship
            : [relsXml.Relationships.Relationship]
          : [];

        for (const rel of relationships) {
          if (rel.Type?.includes("/diagramData")) {
            const diagramPath = rel.Target.replace("../", "ppt/");
            if (zip.files[diagramPath]) {
              const diagramContent = await zip.files[diagramPath].async("text");
              const diagramXml = parser.parse(diagramContent);
              const diagramText = collectTextFromDiagram(diagramXml);
              if (diagramText.length) smartArt.push(diagramText.join(" → "));
            }
          }
        }
      }

      // Extract tables
      const tables = extractTables(slideXml);

      // Extract corresponding notes (if exists)
      let notes = "";
      if (notesFiles[i]) {
        const notesContent = await zip.files[notesFiles[i]].async("text");
        const notesXml = parser.parse(notesContent);
        notes = extractNotes(notesXml);
      }

      const charts = [];
      if (zip.files[slideRelsPath]) {
        const relsContent = await zip.files[slideRelsPath].async("text");
        const relsXml = parser.parse(relsContent);

        const relationships = relsXml.Relationships?.Relationship
          ? Array.isArray(relsXml.Relationships.Relationship)
            ? relsXml.Relationships.Relationship
            : [relsXml.Relationships.Relationship]
          : [];

        for (const rel of relationships) {
          if (rel.Type?.includes("/chart")) {
            const chartPath = rel.Target.replace("../", "ppt/");
            if (zip.files[chartPath]) {
              const chartContent = await zip.files[chartPath].async("text");
              const chartXml = parser.parse(chartContent);
              const chartData = extractChart(chartXml);
              if (chartData) charts.push(chartData);
            }
          }
        }
      }

      slides.push({
        slideNumber: i + 1,
        title: text[0] || "",
        text: text.slice(1),
        smartArt,
        tables,
        charts,
        notes,
      });
    }

    const markdown = slides.map((s) => slideToMarkdown(s)).join("\n\n");

    return { success: true, slides, markdown };
  } catch (err) {
    console.error("[extractPptxXml] Error:", err);
    return { success: false, slides: [], markdown: "" };
  }
}


function extractSlideText(xmlNode) {
  const texts = [];
  if (!xmlNode || typeof xmlNode !== "object") return texts;

  traverse(xmlNode, (node) => {
    if (node.txBody && node.txBody.p) {
      const ps = Array.isArray(node.txBody.p) ? node.txBody.p : [node.txBody.p];
      for (const p of ps) {
        if (p.r) {
          const rs = Array.isArray(p.r) ? p.r : [p.r];
          rs.forEach((r) => r.t && texts.push(r.t));
        } else if (p.t) {
          texts.push(p.t);
        }
      }
    }

    if (node.grpSp) {
      const groupShapes = Array.isArray(node.grpSp) ? node.grpSp : [node.grpSp];
      groupShapes.forEach((g) => {
        texts.push(...extractSlideText(g));
      });
    }
  });

  return texts;
}


// Extract SmartArt recursively from <p:graphicFrame>
export function extractSmartArt(xmlNode) {
  const results = [];

  traverse(xmlNode, (node) => {
    if (node.graphicFrame && node.graphicFrame.graphic) {
      const gData = node.graphicFrame.graphic.graphicData;
      if (gData) {
        const smartText = collectTextFromNodeDedup(gData);
        if (smartText.length) results.push(smartText.join(" → "));
      }
    }
  });

  return results;
}

function collectTextFromNodeDedup(node) {
  const texts = [];

  function recurse(n) {
    if (!n || typeof n !== "object") return;

    if (n.txBody && n.txBody.p) {
      const ps = Array.isArray(n.txBody.p) ? n.txBody.p : [n.txBody.p];
      ps.forEach((p) => {
        if (p.r) {
          const rs = Array.isArray(p.r) ? p.r : [p.r];
          rs.forEach((r) => r.t && texts.push(r.t));
        } else if (p.t) {
          texts.push(p.t);
        }
      });
    }

    for (const key in n) {
      if (typeof n[key] === "object") recurse(n[key]);
    }
  }

  recurse(node);

  // remove duplicate while preserving order
  return [...new Set(texts)];
}

export function collectTextFromDiagram(node) {
  const texts = [];

  function recurse(n) {
    if (!n || typeof n !== "object") return;

    if (n.r) {
      const rs = Array.isArray(n.r) ? n.r : [n.r];
      rs.forEach((r) => {
        if (r.t && typeof r.t === "string") texts.push(r.t.trim());
        ["fld", "delText"].forEach((k) => r[k] && recurse(r[k]));
      });
    }

    if (n.p) {
      const ps = Array.isArray(n.p) ? n.p : [n.p];
      ps.forEach(recurse);
    }

    if (n.t) recurse(n.t);

    for (const key in n) {
      if (typeof n[key] === "object") recurse(n[key]);
    }
  }

  recurse(node);

  // remove duplicate while preserving order
  return [...new Set(texts)];
}


function extractTables(xmlNode) {
  const tables = [];
  traverse(xmlNode, (node) => {
    if (node.tbl && node.tbl.tr) {
      const rows = Array.isArray(node.tbl.tr) ? node.tbl.tr : [node.tbl.tr];
      const tableData = rows.map((row) => {
        const cells = Array.isArray(row.tc) ? row.tc : [row.tc];
        return cells.map((cell) => {
          const ps = cell.txBody?.p;
          if (!ps) return "";
          const pArr = Array.isArray(ps) ? ps : [ps];
          return pArr
            .map((p) => {
              if (!p.r) return p.t || "";
              const rs = Array.isArray(p.r) ? p.r : [p.r];
              return rs.map((r) => r.t || "").join("");
            })
            .join("\n");
        });
      });
      tables.push({ rows: tableData });
    }
  });
  return tables;
}

function extractNotes(xmlNode) {
  const texts = [];
  traverse(xmlNode, (node) => {
    if (node.txBody && node.txBody.p) {
      const ps = Array.isArray(node.txBody.p) ? node.txBody.p : [node.txBody.p];
      for (const p of ps) {
        if (p.r) {
          const rs = Array.isArray(p.r) ? p.r : [p.r];
          rs.forEach((r) => r.t && texts.push(r.t));
        } else if (p.t) {
          texts.push(p.t);
        }
      }
    }

    if (node.grpSp) {
      const groupShapes = Array.isArray(node.grpSp) ? node.grpSp : [node.grpSp];
      groupShapes.forEach((g) => {
        texts.push(...extractNotes(g));
      });
    }
  });

  return texts.join(" ");
}


function extractChart(xmlNode) {
  if (!xmlNode || !xmlNode.chart) return null;
  const series = [];

  function traverseChart(node) {
    if (node.ser) {
      const serArr = Array.isArray(node.ser) ? node.ser : [node.ser];
      for (const s of serArr) {
        const name = s.tx?.strRef?.strCache?.pt?.v || "";
        const val = s.val?.numRef?.numCache?.pt?.v || "";
        series.push({ name, value: val });
      }
    }
    for (const k in node) {
      if (typeof node[k] === "object") traverseChart(node[k]);
    }
  }

  traverseChart(xmlNode.chart.plotArea);
  const title = xmlNode.chart.title?.tx?.rich?.p?.r?.t || "";
  return { title, series };
}

function slideToMarkdown(slide) {
  const lines = [];
  if (slide.title) lines.push(`# ${slide.title}`);
  if (slide.text.length) slide.text.forEach((t) => lines.push(`- ${t}`));
  if (slide.smartArt.length) slide.smartArt.forEach((s) => lines.push(`${s}`));
  if (slide.tables.length) {
    slide.tables.forEach((tbl, idx) => {
      const tblLines = tbl.rows.map((r) => r.join(" | ")).join("\n");
      lines.push(`- Table ${idx + 1}:\n${tblLines}`);
    });
  }
  if (slide.charts.length) {
    slide.charts.forEach((c) => {
      const seriesText = c.series.map((s) => `${s.name} = ${s.value}`).join(", ");
      lines.push(`- Chart: ${c.title} → ${seriesText}`);
    });
  }
  if (slide.notes) lines.push(`- Notes: ${slide.notes}`);
  return lines.join("\n");
}

function traverse(obj, callback) {
  if (typeof obj !== "object" || !obj) return;
  callback(obj);
  for (const key in obj) {
    if (typeof obj[key] === "object") traverse(obj[key], callback);
  }
}



// Flatten slide content to plain text (all text, including SmartArt, tables, charts, notes)
export function flattenSlideText(slides) {
  const lines = [];

  slides.forEach((slide) => {
    if (slide.title) lines.push(slide.title);

    if (slide.text.length) lines.push(...slide.text);

    if (slide.smartArt.length) lines.push(...slide.smartArt);

    if (slide.tables.length) {
      slide.tables.forEach((tbl) => {
        tbl.rows.forEach((row) => {
          lines.push(row.join(" | "));
        });
      });
    }


    if (slide.charts.length) {
      slide.charts.forEach((c) => {
        const seriesText = c.series.map((s) => `${s.name} = ${s.value}`).join(", ");
        lines.push(`${c.title} → ${seriesText}`);
      });
    }


    if (slide.notes) lines.push(slide.notes);

    lines.push("\n---\n");
  });

  return lines.join("\n");
}



