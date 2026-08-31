  const $ = sel => document.querySelector(sel);

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Job postings often paste in with markdown-ish markers instead of real
  // structure: **Label:** for section headers, "* " lines for bullets.
  // Turn those into tags/lists instead of showing raw asterisks.
  function formatJobDescription(text) {
    const withTags = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, (_, label) =>
      `<span class="jd-tag">${label.replace(/:\s*$/, "")}</span>`);
    let html = "";
    let inList = false;
    for (const rawLine of withTags.split("\n")) {
      const line = rawLine.trim();
      const bullet = line.match(/^\*\s+(.*)/);
      if (bullet) {
        if (!inList) { html += `<ul class="jd-list">`; inList = true; }
        html += `<li>${bullet[1]}</li>`;
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line) html += `<p>${line}</p>`;
      }
    }
    if (inList) html += "</ul>";
    return html;
  }

  // ── Repeatable entry lists ──

  function addEntry(listId, templateId, data, isMock) {
    const tmpl = document.getElementById(templateId);
    const node = tmpl.content.cloneNode(true);
    const entry = node.querySelector(".entry");
    entry.querySelector(".remove-btn").addEventListener("click", () => {
      entry.remove();
      render();
    });
    entry.querySelectorAll("input, textarea").forEach(el =>
      el.addEventListener("input", render));
    if (data) {
      Object.keys(data).forEach(cls => {
        const el = entry.querySelector("." + cls);
        if (el) {
          el.value = data[cls];
          if (isMock) el.classList.add("mock-value");
        }
      });
    }
    document.getElementById(listId).appendChild(node);
    render();
  }

  $("#add-experience").addEventListener("click", () => addEntry("experience-list", "experience-template"));
  $("#add-education").addEventListener("click", () => addEntry("education-list", "education-template"));
  $("#add-skill-category").addEventListener("click", () => addEntry("skills-list", "skill-category-template"));

  // Reads the skill-category entries currently in the editor. useReal
  // excludes anything still showing sample placeholder text, same rule
  // render() applies to experience/education before saving/submitting.
  function collectSkillGroups(useReal) {
    return [...document.querySelectorAll('#skills-list .entry')].map(e => {
      const labelEl = e.querySelector(".sc-label");
      const itemsEl = e.querySelector(".sc-items");
      const label = (useReal && labelEl.classList.contains("mock-value")) ? "" : labelEl.value.trim();
      const items = (useReal && itemsEl.classList.contains("mock-value")) ? [] : itemsEl.value.split(",").map(s => s.trim()).filter(Boolean);
      return { label, items };
    }).filter(g => g.label || g.items.length);
  }

  // Serializes categories back to the flat "Label: a, b | Label2: c, d"
  // string the backend's skills field (a free-text column, unaware of
  // categories) already expects.
  function flattenSkillGroups(groups) {
    return groups.map(g => g.label ? `${g.label}: ${g.items.join(", ")}` : g.items.join(", ")).join(" | ");
  }

  // Removes only mock/sample skill-category rows, leaving anything the
  // visitor actually typed alone. Used before an AI call that might come
  // back with nothing useful (empty skillGroups) -- without this, leftover
  // sample data (e.g. a marketing sample's "GTM, HubSpot") stays sitting in
  // the skills section looking like the AI generated it for whatever job
  // was just tailored to, when really the AI call just didn't clear it.
  function clearMockSkillEntries() {
    document.querySelectorAll('#skills-list .entry').forEach(entry => {
      if (entry.querySelector(".sc-label").classList.contains("mock-value") ||
          entry.querySelector(".sc-items").classList.contains("mock-value")) {
        entry.remove();
      }
    });
  }

  // Personal info + summary fields (skill-category inputs are wired by
  // addEntry() itself, same as experience/education entries)
  ["f-name", "f-headline", "f-email", "f-phone", "f-location", "f-link", "f-summary"]
    .forEach(id => document.getElementById(id).addEventListener("input", render));

  $("#download-resume-btn").addEventListener("click", async () => {
    const btn = $("#download-resume-btn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      const tools = await loadDocxTools();
      const data = collectPreviewData();
      const blob = await buildResumeDocxBlob(data, tools.docx);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Job title in the filename (from the headline, which the AI/job-click
      // tailoring flow already sets to the target job's title) so a resume
      // generated for one job doesn't look identical to -- or silently
      // overwrite/get confused with -- one generated for another.
      const slugify = s => (s || "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
      const fileBase = [slugify(data.name) || "resume", slugify(data.headline)].filter(Boolean).join("-");
      a.download = `${fileBase}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      alert("Couldn't generate the download: " + (err.message || "unknown error"));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  function updateApplyButton() {
    $("#apply-job-btn").style.display = (currentJob && currentJob.url) ? "" : "none";
  }

  $("#clear-btn").addEventListener("click", () => {
    if (!confirm("Clear all fields? This can't be undone.")) return;
    document.querySelectorAll("#resume-editor input, #resume-editor textarea").forEach(el => {
      el.value = "";
      el.classList.remove("mock-value");
    });
    document.getElementById("experience-list").innerHTML = "";
    document.getElementById("education-list").innerHTML = "";
    document.getElementById("skills-list").innerHTML = "";
    currentJob = null;
    updateApplyButton();
    render();
  });

  $("#close-editor-btn").addEventListener("click", () => {
    $("#build-view").style.display = "none";
  });

  // First focus on a sample-filled field selects its text so typing
  // immediately replaces it -- doesn't clear on mere click/tab-through,
  // since that read as the field's real content vanishing (it's laid out
  // like the actual resume now, not an obviously-empty boxed input).
  // Capture phase because focus doesn't bubble.
  document.getElementById("build-view").addEventListener("focus", (e) => {
    const el = e.target;
    if (el.classList && el.classList.contains("mock-value") && typeof el.select === "function") {
      el.select();
    }
  }, true);

  // The mock-value -> real transition only happens once the person actually
  // types (not on mere focus) -- capture phase so this runs before the
  // per-field "input" -> render() listeners below, keeping autosave/submit
  // from ever treating untouched sample text as something they entered.
  document.getElementById("build-view").addEventListener("input", (e) => {
    const el = e.target;
    if (el.classList && el.classList.contains("mock-value")) {
      el.classList.remove("mock-value");
    }
  }, true);

  function setSubmitStatus(message, ok) {
    const el = $("#submit-status");
    el.textContent = message;
    el.className = "submit-status " + (ok ? "ok" : "error");
  }

  $("#submit-pool-btn").addEventListener("click", async () => {
    const data = loadResumeData();
    if (!data || !(data.name || data.email)) {
      setSubmitStatus("Add at least a name or email before submitting.", false);
      return;
    }
    setSubmitStatus("Submitting…", true);
    try {
      const res = await fetch(JOBS_API + "/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, session_id: SESSION_ID }),
      });
      if (!res.ok) throw new Error("Server rejected the submission (HTTP " + res.status + ").");
      setSubmitStatus("Submitted — thanks!", true);
    } catch (err) {
      setSubmitStatus("Couldn't submit: " + (err.message || "network error") + ".", false);
    }
  });

  // ── Upload an existing resume: extract its text and drop it into Summary.
  // No reliable way to auto-sort arbitrary resume text into name/experience/
  // education fields without a real parsing service, so this deliberately
  // doesn't pretend to -- it just saves retyping, review/reorganize by hand. ──

  let pdfJsLib = null;
  let pdfJsLoadPromise = null;

  // Vendored locally (vendor/pdfjs/) rather than pulled from a CDN -- the
  // CDN version this used to point at (cdnjs, pinned to an old pdf.js
  // release) got pruned server-side and started 404ing outright, and
  // relying on any third-party domain here is one more thing that can be
  // blocked by a network filter or ad-blocker. Same-origin, nothing to block.
  function loadPdfJs() {
    if (pdfJsLib) return Promise.resolve(pdfJsLib);
    if (pdfJsLoadPromise) return pdfJsLoadPromise;
    pdfJsLoadPromise = import("./vendor/pdfjs/pdf.min.mjs")
      .then(mod => {
        mod.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.mjs";
        pdfJsLib = mod;
        return mod;
      })
      .catch(err => {
        pdfJsLoadPromise = null;
        throw new Error("Couldn't load the PDF reader: " + (err.message || err));
      });
    return pdfJsLoadPromise;
  }

  async function extractPdfText(file) {
    const pdfjsLib = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(" ") + "\n\n";
    }
    return text.trim();
  }

  let mammothLib = null;
  let mammothLoadPromise = null;

  // Same vendoring rationale as pdf.js above -- self-contained UMD build,
  // same-origin, nothing a CDN outage or blocker can take down.
  function loadMammoth() {
    if (mammothLib) return Promise.resolve(mammothLib);
    if (mammothLoadPromise) return mammothLoadPromise;
    mammothLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/mammoth/mammoth.browser.min.js";
      script.onload = () => {
        if (window.mammoth) resolve(window.mammoth);
        else reject(new Error("mammoth failed to initialize"));
      };
      script.onerror = () => reject(new Error("Couldn't load the DOCX reader"));
      document.head.appendChild(script);
    }).then(lib => { mammothLib = lib; return lib; })
      .catch(err => { mammothLoadPromise = null; throw err; });
    return mammothLoadPromise;
  }

  async function extractDocxText(file) {
    const mammoth = await loadMammoth();
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value.trim();
  }

  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.readAsText(file);
    });
  }

  function setUploadStatus(message, ok) {
    const el = $("#upload-status");
    el.textContent = message;
    el.className = "upload-status " + (ok ? "ok" : "error");
  }

  // Best-effort extraction of a few high-confidence Personal Info fields from
  // raw resume text -- email/phone/link are reliable regex targets, name is a
  // first-line heuristic (works for the vast majority of resumes, which lead
  // with the person's name on its own line). Never overwrites a field the
  // person already filled in, and doesn't touch anything else (Experience/
  // Education still need a human -- too varied/error-prone to guess at).
  const SECTION_HEADER_WORDS = /^(summary|profile|objective|experience|education|skills|contact|projects|certifications|about)\b/i;

  function guessPersonalInfo(text) {
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/);
    // Digit-count-based rather than a fixed grouping pattern -- phone formats
    // vary a lot by country (e.g. "98765 43210" in India vs "(415) 555-0192"
    // in the US), so match any digit-and-punctuation run with a plausible
    // total digit count instead of assuming one grouping shape.
    const dateShaped = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;
    const phoneCandidates = text.match(/\+?\(?\d[\d\-.\s()]{6,}\d/g) || [];
    const phoneMatch = phoneCandidates.find(c => {
      const digits = (c.match(/\d/g) || []).length;
      return digits >= 7 && digits <= 15 && !dateShaped.test(c.trim());
    });
    const linkedinMatch = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i);
    const githubMatch = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[a-zA-Z0-9\-_]+/i);

    let name = "";
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.length > 60 || /\d/.test(line) || line.includes("@") || SECTION_HEADER_WORDS.test(line)) continue;
      name = line;
      break;
    }

    return {
      name,
      email: emailMatch ? emailMatch[0] : "",
      phone: phoneMatch ? phoneMatch.trim() : "",
      link: linkedinMatch ? linkedinMatch[0] : (githubMatch ? githubMatch[0] : ""),
    };
  }

  function fillIfEmpty(id, value) {
    if (!value) return false;
    const el = $("#" + id);
    // Sample placeholder text still counts as "empty" -- it isn't anything
    // the visitor typed, so it's fine to overwrite; real typed text isn't.
    if (el.value.trim() && !el.classList.contains("mock-value")) return false;
    el.value = value;
    el.classList.remove("mock-value");
    return true;
  }

  // Sends extracted resume text to the backend's AI parser, which returns
  // the resume builder's own field shape (name/contact/summary/skillGroups/
  // experience/education). Returns null on any failure so the caller can
  // fall back to the old raw-text-in-Summary behavior instead of losing the
  // extracted text entirely.
  async function parseResumeText(text) {
    try {
      const res = await fetch(JOBS_API + "/api/parse-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 12000) }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // Fills every section from a successful parse. Personal info/summary only
  // overwrite empty-or-sample fields (never something the visitor already
  // typed); Experience/Education/Skills replace whatever rows are there
  // (sample or otherwise) since there's no per-row "already real" check --
  // but only for a section the parse actually found something for, so a
  // partial parse doesn't wipe sections it simply didn't return.
  function applyParsedResume(data) {
    fillIfEmpty("f-name", data.name);
    fillIfEmpty("f-headline", data.headline);
    fillIfEmpty("f-email", data.email);
    fillIfEmpty("f-phone", data.phone);
    fillIfEmpty("f-location", data.location);
    fillIfEmpty("f-link", data.link);
    if (data.summary) fillIfEmpty("f-summary", data.summary);

    if ((data.experience || []).length) {
      document.getElementById("experience-list").innerHTML = "";
      data.experience.forEach(e => addEntry("experience-list", "experience-template", {
        "e-title": e.title, "e-company": e.company, "e-location": e.location,
        "e-start": e.start, "e-end": e.end, "e-bullets": (e.bullets || []).join("\n"),
      }));
    }

    if ((data.education || []).length) {
      document.getElementById("education-list").innerHTML = "";
      data.education.forEach(e => addEntry("education-list", "education-template", {
        "d-degree": e.degree, "d-school": e.school, "d-location": e.location,
        "d-start": e.start, "d-end": e.end,
      }));
    }

    clearMockSkillEntries();
    if ((data.skillGroups || []).length) {
      document.getElementById("skills-list").innerHTML = "";
      data.skillGroups.forEach(g => addEntry("skills-list", "skill-category-template", {
        "sc-label": g.label, "sc-items": (g.items || []).join(", "),
      }));
    }

    render();
  }

  $("#resume-upload-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadStatus("Reading " + file.name + "…", true);

    try {
      let text;
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        text = await extractPdfText(file);
      } else if (file.name.toLowerCase().endsWith(".docx") ||
          file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        text = await extractDocxText(file);
      } else if (file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt")) {
        text = await readTextFile(file);
      } else {
        setUploadStatus("Only PDF, .docx or .txt files can be auto-read -- fill the form manually for other formats.", false);
        return;
      }

      if (!text || !text.trim()) {
        setUploadStatus("Couldn't find any text in that file (is it a scanned image?). Fill the form manually instead.", false);
        return;
      }

      setUploadStatus("Reading " + file.name + " -- filling in your resume…", true);
      const parsed = await parseResumeText(text);

      if (parsed) {
        applyParsedResume(parsed);
        setUploadStatus("Filled in from " + file.name + " -- please review every section before submitting.", true);
        return;
      }

      // AI parse unavailable/failed -- fall back to the old behavior so the
      // extracted text isn't just lost: dump it into Summary and best-effort
      // regex-guess a few personal-info fields.
      const summaryEl = $("#f-summary");
      const note = "--- Extracted from " + file.name + " -- review and copy details into the right sections below ---\n\n";
      summaryEl.value = note + text.slice(0, 4000);
      summaryEl.classList.remove("mock-value");

      const guessed = guessPersonalInfo(text);
      const filled = [];
      if (fillIfEmpty("f-name", guessed.name)) filled.push("name");
      if (fillIfEmpty("f-email", guessed.email)) filled.push("email");
      if (fillIfEmpty("f-phone", guessed.phone)) filled.push("phone");
      if (fillIfEmpty("f-link", guessed.link)) filled.push("link");

      render();
      const filledNote = filled.length
        ? ` Also guessed ${filled.join(", ")} above -- please double-check.`
        : "";
      setUploadStatus("Couldn't auto-fill sections right now -- dropped the extracted text into Summary instead." + filledNote, true);
    } catch (err) {
      setUploadStatus(err.message || "Couldn't extract text from that file.", false);
    }
  });

  // ── Live "exact Word formatting" preview: rather than approximating the
  // reference resume's look with hand-written CSS (which has a hard ceiling
  // -- no CSS layout truly matches Word's own), this builds a REAL .docx
  // from the current form data, using the same paragraph styles pulled from
  // the reference file (Heading1/Heading2 colors+sizes, tab-stop-aligned
  // bold company/dates, bullet numbering), and renders that actual file
  // with docx-preview. What's shown on screen is Word's own layout engine,
  // not a guess at it -- and it's the exact file Download hands over. ──

  let jsZipLoadPromise = null;
  function loadJsZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jsZipLoadPromise) return jsZipLoadPromise;
    jsZipLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/jszip/jszip.min.js";
      script.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error("JSZip failed to initialize"));
      script.onerror = () => reject(new Error("Couldn't load JSZip"));
      document.head.appendChild(script);
    }).catch(err => { jsZipLoadPromise = null; throw err; });
    return jsZipLoadPromise;
  }

  let docxToolsLib = null; // { docx: <generator lib>, docxPreview: <renderer lib> }
  let docxToolsLoadPromise = null;

  // docx (generates .docx files) and docx-preview (renders them) are two
  // separate packages that both assign themselves to the same UMD global
  // (window.docx) when loaded as plain <script> tags. Load docx-preview
  // first and capture it immediately, before docx's script tag overwrites
  // window.docx with itself.
  function loadDocxTools() {
    if (docxToolsLib) return Promise.resolve(docxToolsLib);
    if (docxToolsLoadPromise) return docxToolsLoadPromise;
    docxToolsLoadPromise = loadJsZip()
      .then(() => new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "vendor/docx-preview/docx-preview.min.js";
        script.onload = () => window.docx ? resolve(window.docx) : reject(new Error("docx-preview failed to initialize"));
        script.onerror = () => reject(new Error("Couldn't load the document previewer"));
        document.head.appendChild(script);
      }))
      .then(docxPreview => new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "vendor/docx/docx.umd.js";
        script.onload = () => window.docx ? resolve({ docx: window.docx, docxPreview }) : reject(new Error("docx generator failed to initialize"));
        script.onerror = () => reject(new Error("Couldn't load the document generator"));
        document.head.appendChild(script);
      }))
      .then(lib => { docxToolsLib = lib; return lib; })
      .catch(err => { docxToolsLoadPromise = null; throw err; });
    return docxToolsLoadPromise;
  }

  const RESUME_ACCENT_HEX = "2E74B5"; // the reference doc's actual heading-color
  const PAGE_WIDTH_TWIP = 12240;   // 8.5in Letter, twentieths of a point
  const PAGE_HEIGHT_TWIP = 15840;  // 11in Letter
  const PAGE_MARGIN_TWIP = 600;    // 30pt -- matches the reference doc's tight margins
  const CONTENT_WIDTH_TWIP = PAGE_WIDTH_TWIP - 2 * PAGE_MARGIN_TWIP;

  // Builds a real .docx Blob from the resume-builder's own field shape,
  // mirroring the reference file's actual Word styles (extracted from its
  // styles.xml/document.xml) rather than approximating them.
  async function buildResumeDocxBlob(data, docxLib) {
    const {
      Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, TabStopType,
    } = docxLib;

    function sectionHeader(text) {
      return new Paragraph({
        heading: HeadingLevel.HEADING_2,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } },
        spacing: { before: 120, after: 60 },
        children: [new TextRun({ text })],
      });
    }

    // One line combining a bold "lead" (company/degree), optional plain
    // "rest" (role/location), and a bold right-tab-aligned date -- matches
    // the reference doc's "**Company**, Title␉**Dates**" pattern exactly.
    function entryLine(lead, rest, dates) {
      const children = [new TextRun({ text: lead, bold: true })];
      if (rest) children.push(new TextRun({ text: rest }));
      if (dates) children.push(new TextRun({ text: `\t${dates}`, bold: true }));
      return new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
        spacing: { before: 80, after: 40 },
        children,
      });
    }

    function bulletLine(text) {
      return new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 20 } });
    }

    const children = [];

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: data.name || "Your Name" })],
    }));

    if (data.headline) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new TextRun({ text: data.headline, bold: true, color: RESUME_ACCENT_HEX })],
      }));
    }

    const contactParts = [data.email, data.phone, data.location, data.link].filter(Boolean);
    if (contactParts.length) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: contactParts.join(" | ") })],
      }));
    }

    if (data.summary) {
      children.push(sectionHeader("PROFESSIONAL SUMMARY"));
      children.push(new Paragraph({ text: data.summary, spacing: { after: 80 } }));
    }

    const experience = (data.experience || []).filter(e => e.title || e.company);
    if (experience.length) {
      children.push(sectionHeader("WORK EXPERIENCE"));
      experience.forEach(e => {
        const lead = e.company || e.title;
        const restBits = [];
        if (e.company && e.title) restBits.push(`, ${e.title}`);
        if (e.location) restBits.push((restBits.length ? " — " : "") + e.location);
        children.push(entryLine(lead, restBits.join(""), [e.start, e.end].filter(Boolean).join(" – ")));
        (e.bullets || []).forEach(b => children.push(bulletLine(b)));
      });
    }

    const skillGroups = (data.skillGroups || []).filter(g => g.items && g.items.length);
    if (skillGroups.length) {
      children.push(sectionHeader("TECHNICAL SKILLS"));
      skillGroups.forEach(g => {
        children.push(new Paragraph({
          spacing: { after: 40 },
          children: g.label
            ? [new TextRun({ text: `${g.label}: `, bold: true }), new TextRun({ text: g.items.join(", ") })]
            : [new TextRun({ text: g.items.join(", ") })],
        }));
      });
    }

    const education = (data.education || []).filter(e => e.degree || e.school);
    if (education.length) {
      children.push(sectionHeader("EDUCATION"));
      education.forEach(e => {
        const lead = e.degree || e.school;
        children.push(entryLine(lead, "", [e.start, e.end].filter(Boolean).join(" – ")));
        if (e.degree) {
          const schoolLine = [e.school, e.location].filter(Boolean).join(" — ");
          if (schoolLine) children.push(new Paragraph({ text: schoolLine, indent: { left: 200 }, spacing: { after: 80 } }));
        }
      });
    }

    const doc = new Document({
      styles: {
        default: { document: { run: { font: "Tinos", size: 20 } } },
        paragraphStyles: [
          { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { color: RESUME_ACCENT_HEX, size: 32 } },
          { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { color: RESUME_ACCENT_HEX, size: 26, bold: true } },
        ],
      },
      sections: [{
        properties: {
          page: {
            size: { width: PAGE_WIDTH_TWIP, height: PAGE_HEIGHT_TWIP },
            margin: { top: PAGE_MARGIN_TWIP, right: PAGE_MARGIN_TWIP, bottom: PAGE_MARGIN_TWIP, left: PAGE_MARGIN_TWIP },
          },
        },
        children,
      }],
    });

    return Packer.toBlob(doc);
  }

  let docxPreviewGeneration = 0;
  let docxPreviewDebounceTimer = null;

  function scheduleDocxPreviewRender(data) {
    clearTimeout(docxPreviewDebounceTimer);
    docxPreviewDebounceTimer = setTimeout(() => renderDocxPreview(data), 450);
  }

  // A generation counter drops a render that finishes after a newer one was
  // already requested (e.g. two keystrokes close together both trigger a
  // build+render; only the later one should ever reach the DOM).
  async function renderDocxPreview(data) {
    const myGeneration = ++docxPreviewGeneration;
    const target = document.getElementById("docx-preview-target");
    if (!target) return;
    try {
      const tools = await loadDocxTools();
      if (myGeneration !== docxPreviewGeneration) return;
      const blob = await buildResumeDocxBlob(data, tools.docx);
      if (myGeneration !== docxPreviewGeneration) return;
      target.innerHTML = "";
      await tools.docxPreview.renderAsync(blob, target, target, {
        inWrapper: true,
        breakPages: true,
        ignoreFonts: false,
      });
    } catch (err) {
      if (myGeneration !== docxPreviewGeneration) return;
      target.innerHTML = `<div class="preview-error">Couldn't render the live preview (${escapeHtml(err.message || "unknown error")}). Your data is still saved -- try again in a moment.</div>`;
    }
  }

  // Reads the current form state into the plain-object shape both the live
  // preview and the docx download build from. Includes sample/mock
  // placeholder text (unlike the real* variables inside render() below) so
  // the preview is never blank before the visitor has typed anything.
  function collectPreviewData() {
    return {
      name: $("#f-name").value.trim(),
      headline: $("#f-headline").value.trim(),
      email: $("#f-email").value.trim(),
      phone: $("#f-phone").value.trim(),
      location: $("#f-location").value.trim(),
      link: $("#f-link").value.trim(),
      summary: $("#f-summary").value.trim(),
      skillGroups: collectSkillGroups(false),
      experience: [...document.querySelectorAll('#experience-list .entry')].map(e => ({
        title: e.querySelector(".e-title").value.trim(),
        company: e.querySelector(".e-company").value.trim(),
        location: e.querySelector(".e-location").value.trim(),
        start: e.querySelector(".e-start").value.trim(),
        end: e.querySelector(".e-end").value.trim(),
        bullets: e.querySelector(".e-bullets").value.split("\n").map(s => s.trim()).filter(Boolean),
      })),
      education: [...document.querySelectorAll('#education-list .entry')].map(e => ({
        degree: e.querySelector(".d-degree").value.trim(),
        school: e.querySelector(".d-school").value.trim(),
        location: e.querySelector(".d-location").value.trim(),
        start: e.querySelector(".d-start").value.trim(),
        end: e.querySelector(".d-end").value.trim(),
      })),
    };
  }

  // ── Render preview from current form state ──

  function render() {
    scheduleDocxPreviewRender(collectPreviewData());

    // What actually gets saved/sent excludes anything still showing sample
    // placeholder text -- clicking one field only clears that field, so the
    // rest of the demo profile shouldn't be treated as if the visitor typed
    // it.
    const realVal = el => el.classList.contains("mock-value") ? "" : el.value.trim();

    const realExperience = [...document.querySelectorAll('#experience-list .entry')].map(e => {
      const bulletsEl = e.querySelector(".e-bullets");
      return {
        title: realVal(e.querySelector(".e-title")),
        company: realVal(e.querySelector(".e-company")),
        location: realVal(e.querySelector(".e-location")),
        start: realVal(e.querySelector(".e-start")),
        end: realVal(e.querySelector(".e-end")),
        bullets: bulletsEl.classList.contains("mock-value")
          ? [] : bulletsEl.value.split("\n").map(s => s.trim()).filter(Boolean),
      };
    }).filter(e => e.title || e.company || e.location || e.start || e.end || e.bullets.length);

    const realEducation = [...document.querySelectorAll('#education-list .entry')].map(e => ({
      degree: realVal(e.querySelector(".d-degree")),
      school: realVal(e.querySelector(".d-school")),
      location: realVal(e.querySelector(".d-location")),
      start: realVal(e.querySelector(".d-start")),
      end: realVal(e.querySelector(".d-end")),
    })).filter(e => e.degree || e.school || e.location || e.start || e.end);

    const realSkillGroups = collectSkillGroups(true);

    const dataOut = {
      name: realVal($("#f-name")),
      headline: realVal($("#f-headline")),
      email: realVal($("#f-email")),
      phone: realVal($("#f-phone")),
      location: realVal($("#f-location")),
      link: realVal($("#f-link")),
      summary: realVal($("#f-summary")),
      skills: flattenSkillGroups(realSkillGroups),
      skillGroups: realSkillGroups,
      experience: realExperience,
      education: realEducation,
    };
    saveResumeData(dataOut);
    if (!suppressDraftSave) scheduleDraftSave(dataOut);
  }

  // ── Persistence: everything typed into the resume auto-saves to this
  // browser's localStorage on every change, and survives reload/reopen. ──

  const RESUME_DATA_KEY = "resume_builder_data_v1";

  function saveResumeData(data) {
    localStorage.setItem(RESUME_DATA_KEY, JSON.stringify(data));
  }

  function loadResumeData() {
    const raw = localStorage.getItem(RESUME_DATA_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── Auto-save to the backend as the visitor types (disclosed in the
  // draft-notice below the resume). Debounced so it's one request
  // per pause in typing, not one per keystroke. Keyed by a per-browser
  // session id so repeated saves update the same row instead of piling up
  // duplicates. Clicking "Submit to talent pool" later marks this same row
  // finalized -- it doesn't create a second copy. ──

  // Suppressed during the initial page-load render (which may just be showing
  // placeholder sample data, not anything a visitor typed) and lifted right
  // after -- real edits from then on (typing, or restoring this same
  // browser's own earlier saved data) are what actually trigger a draft send.
  let suppressDraftSave = true;

  const SESSION_ID_KEY = "resume_session_id_v1";

  function getOrCreateSessionId() {
    let id = localStorage.getItem(SESSION_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));
      localStorage.setItem(SESSION_ID_KEY, id);
    }
    return id;
  }
  const SESSION_ID = getOrCreateSessionId();

  let draftSaveTimer = null;
  function scheduleDraftSave(data) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => sendDraft(data), 1200);
  }
  async function sendDraft(data) {
    if (!data || !(data.name || data.headline || data.email || data.summary ||
        data.skills || (data.experience && data.experience.length) ||
        (data.education && data.education.length))) return;
    try {
      await fetch(JOBS_API + "/api/resumes/draft", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, session_id: SESSION_ID }),
      });
    } catch {
      // best-effort background save; local copy already succeeded
    }
  }

  function hasSavedContent(data) {
    if (!data) return false;
    return Boolean(
      data.name || data.headline || data.summary ||
      (data.experience && data.experience.length) ||
      (data.education && data.education.length)
    );
  }

  function restoreResumeData(data) {
    $("#f-name").value = data.name || "";
    $("#f-headline").value = data.headline || "";
    $("#f-email").value = data.email || "";
    $("#f-phone").value = data.phone || "";
    $("#f-location").value = data.location || "";
    $("#f-link").value = data.link || "";
    $("#f-summary").value = data.summary || "";

    (data.experience || []).forEach(e => addEntry("experience-list", "experience-template", {
      "e-title": e.title, "e-company": e.company, "e-location": e.location,
      "e-start": e.start, "e-end": e.end, "e-bullets": (e.bullets || []).join("\n"),
    }));
    (data.education || []).forEach(e => addEntry("education-list", "education-template", {
      "d-degree": e.degree, "d-school": e.school, "d-location": e.location,
      "d-start": e.start, "d-end": e.end,
    }));

    if (data.skillGroups && data.skillGroups.length) {
      data.skillGroups.forEach(g => addEntry("skills-list", "skill-category-template", {
        "sc-label": g.label, "sc-items": (g.items || []).join(", "),
      }));
    } else if (data.skills) {
      // Pre-existing draft saved before skills had categories -- keep the
      // flat list rather than silently dropping it.
      addEntry("skills-list", "skill-category-template", { "sc-label": "", "sc-items": data.skills });
    }
  }

  // ── View switching (Jobs is the homepage; Build Resume is reached from a
  // job result's "Generate Resume" button, or the back link once there) ──

  const JOBS_API = "https://13-126-187-97.sslip.io";
  let currentSearchJobs = [];
  let currentSearchLabel = "jobs";
  let lastSearchTerm = "";
  let currentJob = null; // job the resume-in-progress is targeting (for the Apply button)

  // Mounts the (single, shared) resume editor right after whichever button
  // triggered it -- a job card in the results list, or the detail page's
  // actions row -- instead of navigating to a separate page.
  function showBuildView(anchorEl) {
    const bv = $("#build-view");
    if (anchorEl) anchorEl.insertAdjacentElement("afterend", bv);
    bv.style.display = "";
    render();
    bv.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Homepage shortcut: build a resume with no job attached (sample/saved
  // data already populates the editor on load) instead of requiring a search.
  $("#build-resume-btn").addEventListener("click", () => {
    currentJob = null;
    updateApplyButton();
    showBuildView($("#build-resume-btn"));
  });

  // ── Jobs search ──

  function escapeAttr(s) {
    return (s || "").replace(/"/g, "&quot;");
  }

  const SITE_LABELS = { indeed: "Indeed", linkedin: "LinkedIn", glassdoor: "Glassdoor", zip_recruiter: "ZipRecruiter", google: "Google", naukri: "Naukri" };

  function jobCardHtml(j, index) {
    const dTitle = escapeAttr(j.title);
    const dCompany = escapeAttr(j.company);
    const dSite = escapeAttr(j.site);
    const dUrl = escapeAttr(j.url);
    // data-job-index is the real lookup key (a direct index into
    // currentSearchJobs) -- the title/company/etc attributes below are only
    // a display/fallback copy, not re-matched against on click. Re-matching
    // by re-escaped title+company+url was fragile (any encoding mismatch
    // silently grabbed the wrong job's -- or no -- description).
    const dAttrs = `data-job-index="${index}" data-job-title="${dTitle}" data-job-company="${dCompany}" data-job-site="${dSite}" data-job-url="${dUrl}"`;
    return `
      <div class="job-card">
        <div class="job-card-top">
          <div>
            <button type="button" class="job-title" data-click-action="view_job" ${dAttrs}>${escapeHtml(j.title)}</button>
            <div class="job-company">${escapeHtml(j.company)}${j.location ? " — " + escapeHtml(j.location) : ""}</div>
            <div class="job-meta">${[SITE_LABELS[j.site] || j.site, j.job_type, j.is_remote ? "Remote" : null, j.date_posted].filter(Boolean).map(escapeHtml).join(" · ")}</div>
          </div>
          <div class="job-actions">
            <button data-click-action="generate_resume" ${dAttrs}>Generate Resume</button>
            <button data-click-action="share_job" ${dAttrs}>Share</button>
            ${j.url ? `<a data-click-action="open_link" ${dAttrs} href="${dUrl}" target="_blank" rel="noopener">Open</a>` : ""}
          </div>
        </div>
        ${j.description ? `<div class="job-desc">${escapeHtml(j.description)}</div>` : ""}
      </div>
    `;
  }

  // Click tracking + Generate-Resume dispatch, delegated from the results
  // container since cards are inserted as raw HTML strings as they stream in.
  function logJobClick(action, job) {
    fetch(JOBS_API + "/api/job-clicks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action, job_title: job.title, company: job.company,
        site: job.site, url: job.url,
        search_term: lastSearchTerm, session_id: SESSION_ID,
      }),
    }).catch(() => {});
  }

  async function shareJob(job, buttonEl) {
    const shareText = `${job.title}${job.company ? " at " + job.company : ""}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: shareText, text: shareText, url: job.url || undefined });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled, no fallback needed
      }
    }
    try {
      await navigator.clipboard.writeText(job.url || shareText);
      if (buttonEl) {
        const original = buttonEl.textContent;
        buttonEl.textContent = "Copied!";
        setTimeout(() => { buttonEl.textContent = original; }, 1500);
      }
    } catch (err) {
      // clipboard unavailable (insecure context, permissions) -- nothing more we can do
    }
  }

  $("#jobs-results").addEventListener("click", (e) => {
    const el = e.target.closest("[data-click-action]");
    if (!el) return;
    // The index is the real lookup -- direct hit into the array this exact
    // card was rendered from, so it can't grab a different job's data.
    const full = currentSearchJobs[Number(el.dataset.jobIndex)];
    const job = full
      ? { title: full.title, company: full.company, site: full.site, url: full.url }
      : {
          title: el.dataset.jobTitle || "",
          company: el.dataset.jobCompany || "",
          site: el.dataset.jobSite || "",
          url: el.dataset.jobUrl || "",
        };
    logJobClick(el.dataset.clickAction, job);
    if (el.dataset.clickAction === "generate_resume") {
      currentJob = job;
      generateResumeForJob(job.title, full ? full.description : "", el.closest(".job-card"));
    } else if (el.dataset.clickAction === "share_job") {
      shareJob(job, el);
    } else if (el.dataset.clickAction === "view_job") {
      showJobDetailView(job, full ? full.description : "");
    }
  });

  // ── Job detail view: reconstructs the posting in-app instead of sending
  // the person to the source site. Only "Open" / "Apply" leave the app. ──

  let currentJobDescription = "";

  function showJobDetailView(job, description) {
    currentJob = job;
    currentJobDescription = description || "";
    $("#jd-title").textContent = job.title;
    $("#jd-company").textContent = job.company || "";
    $("#jd-meta").textContent = [SITE_LABELS[job.site] || job.site].filter(Boolean).join(" · ");
    $("#jd-description").innerHTML = description
      ? formatJobDescription(description)
      : "No description available for this listing.";
    $("#jobs-view").style.display = "none";
    $("#job-detail-view").style.display = "";
  }

  function hideJobDetailView() {
    $("#job-detail-view").style.display = "none";
    $("#jobs-view").style.display = "";
  }

  $("#back-to-results-btn").addEventListener("click", hideJobDetailView);

  $("#jd-generate-btn").addEventListener("click", () => {
    logJobClick("generate_resume", currentJob);
    generateResumeForJob(currentJob.title, currentJobDescription, $(".job-detail-actions"));
  });

  $("#apply-job-btn").addEventListener("click", () => {
    if (!currentJob || !currentJob.url) return;
    logJobClick("apply_click", currentJob);
    window.open(currentJob.url, "_blank", "noopener");
  });

  // ── Custom country dropdown ──
  const countryWrap = $("#job-country");
  const countryBtn = $("#job-country-btn");
  const countryLabelEl = $("#job-country-label");
  const countryList = $("#job-country-list");

  function getCountryValue() { return countryWrap.dataset.value; }
  function getCountryLabelText() { return countryLabelEl.textContent; }
  function setCountryValue(value) {
    const item = countryList.querySelector(`li[data-value="${value}"]`);
    if (!item) return;
    countryWrap.dataset.value = value;
    countryLabelEl.textContent = item.textContent;
    countryList.querySelectorAll("li").forEach(li => li.setAttribute("aria-selected", li === item ? "true" : "false"));
  }
  function openCountryList() {
    countryList.hidden = false;
    countryWrap.classList.add("open");
    countryBtn.setAttribute("aria-expanded", "true");
  }
  function closeCountryList() {
    countryList.hidden = true;
    countryWrap.classList.remove("open");
    countryBtn.setAttribute("aria-expanded", "false");
  }
  countryBtn.addEventListener("click", () => {
    countryList.hidden ? openCountryList() : closeCountryList();
  });
  countryList.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    setCountryValue(li.dataset.value);
    closeCountryList();
  });
  document.addEventListener("click", (e) => {
    if (!countryWrap.contains(e.target)) closeCountryList();
  });
  countryBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); openCountryList(); }
    if (e.key === "Escape") closeCountryList();
  });

  // Indeed is scoped entirely by the country dropdown (country_indeed), not by
  // the typed location -- if someone types an India city but the dropdown is
  // still sitting on its default "USA", Indeed silently searches the US site
  // and returns 0 results with no indication why. Auto-correct the dropdown
  // from whatever country name/alias shows up in the typed text.
  const COUNTRY_ALIASES = {
    usa: ["usa", "united states", " us ", "us,"],
    india: ["india"],
    uk: ["uk", "united kingdom", "england", "britain", "scotland", "wales"],
    canada: ["canada"],
    australia: ["australia"],
    germany: ["germany"],
    singapore: ["singapore"],
    uae: ["uae", "united arab emirates", "dubai", "abu dhabi"],
  };
  function detectCountryFromLocation(locationText) {
    const hay = ` ${locationText.toLowerCase()} `;
    for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
      if (aliases.some(a => hay.includes(a))) return code;
    }
    return null;
  }

  const JOB_DICT_SET = new Set(JOB_DICTIONARY);

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        d[i][j] = a[i - 1] === b[j - 1]
          ? d[i - 1][j - 1]
          : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
      }
    }
    return d[m][n];
  }

  function autoCorrectTerm(text) {
    let changed = false;
    const corrected = text.split(/(\s+)/).map(word => {
      const lower = word.toLowerCase();
      if (!/^[a-z]{4,}$/.test(lower) || JOB_DICT_SET.has(lower)) return word;
      const maxDist = lower.length >= 7 ? 2 : 1;
      let best = null, bestDist = Infinity, tie = false;
      for (const dictWord of JOB_DICTIONARY) {
        if (Math.abs(dictWord.length - lower.length) > maxDist) continue;
        const dist = levenshtein(lower, dictWord);
        if (dist < bestDist) { best = dictWord; bestDist = dist; tie = false; }
        else if (dist === bestDist) tie = true;
      }
      if (best && bestDist <= maxDist && bestDist > 0 && !tie) {
        changed = true;
        // preserve the original capitalization style
        if (word[0] === word[0].toUpperCase()) return best[0].toUpperCase() + best.slice(1);
        return best;
      }
      return word;
    }).join("");
    return { text: corrected, changed };
  }

  const HOURS_LABELS = { 24: "the last 24 hrs", 72: "the last 3 days", 168: "the last week", 336: "the last 2 weeks", 720: "the last month" };

  async function runJobSearch() {
    let term = $("#job-search-term").value.trim();
    const location = $("#job-location").value.trim();
    const hoursOld = parseInt($("#job-hours").value, 10) || 24;
    const hoursLabel = HOURS_LABELS[hoursOld] || `the last ${hoursOld} hrs`;

    const correction = autoCorrectTerm(term);
    let correctedFrom = null;
    if (correction.changed) {
      correctedFrom = term;
      term = correction.text;
      $("#job-search-term").value = term;
    }

    const detected = location ? detectCountryFromLocation(location) : null;
    if (detected && detected !== getCountryValue()) {
      setCountryValue(detected);
    }
    const country = getCountryValue();
    const countryLabel = getCountryLabelText();
    // LinkedIn (and Glassdoor/ZipRecruiter) only ever see the raw `location`
    // string below -- country_indeed only scopes Indeed's own domain. Without
    // the country folded in here, a bare city name is ambiguous worldwide and
    // LinkedIn's free-text geo resolver guesses, often landing in the wrong
    // country/region entirely.
    const locationForApi = location && !location.toLowerCase().includes(countryLabel.toLowerCase())
      ? `${location}, ${countryLabel}`
      : location;

    $("#jobs-view").classList.add("searched"); // shrinks the hero, reveals results area

    if (!term) {
      $("#jobs-status").textContent = "Enter a job title or keyword to search.";
      return;
    }

    // AI-refine a vague/colloquial query ("offshore") into the specific job
    // title/keyword phrase recruiters actually post under, since Indeed/
    // LinkedIn (via jobspy) just keyword-match the raw search term as-is.
    // Best-effort and time-boxed -- any failure or timeout just searches with
    // what the person typed, never blocks the search on this.
    let refinedFrom = null;
    $("#jobs-status").textContent = "Refining search…";
    try {
      const rres = await fetch(JOBS_API + "/api/refine-search-term", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search_term: term, location: locationForApi }),
        signal: AbortSignal.timeout(6000),
      });
      if (rres.ok) {
        const rdata = await rres.json();
        if (rdata.changed && rdata.refined) {
          refinedFrom = term;
          term = rdata.refined;
        }
      }
    } catch (err) { /* AI refinement unavailable -- search with the original term */ }

    $("#jobs-status").textContent = `Searching jobs posted in ${hoursLabel}…`;
    // The resume editor may currently be mounted under a card from the
    // previous search -- rescue it before wiping the results, or every
    // subsequent $("#...") lookup into it (which are just querySelector
    // calls scoped to the document) starts returning null.
    const bv = $("#build-view");
    if (bv && $("#jobs-results").contains(bv)) {
      bv.style.display = "none";
      document.body.appendChild(bv);
    }
    $("#jobs-results").innerHTML = "";
    $("#jobs-loader").style.display = "flex";
    $("#download-csv-btn").style.display = "none";

    currentSearchJobs = [];
    currentSearchLabel = term + (location ? " in " + location : "");
    lastSearchTerm = term;
    const requestedSites = ["indeed", "linkedin", "glassdoor", "zip_recruiter", "google", "naukri"];
    const siteCounts = Object.fromEntries(requestedSites.map(s => [s, null])); // null = still running
    let total = 0;

    const updateStatus = () => {
      const breakdown = requestedSites
        .map(s => `${SITE_LABELS[s]}: ${siteCounts[s] === null ? "…" : siteCounts[s]}`)
        .join(", ");
      const stillWaiting = requestedSites.some(s => siteCounts[s] === null);
      const note = stillWaiting ? " LinkedIn is usually the slowest — can take up to a minute, keep this open." : "";
      const correctionNote = correctedFrom ? ` (auto-corrected from "${correctedFrom}")` : "";
      const refinedNote = refinedFrom ? ` (AI-refined from "${refinedFrom}" for more relevant results)` : "";
      $("#jobs-status").textContent = `${total} result${total === 1 ? "" : "s"} posted in ${hoursLabel} so far for "${term}"${location ? " in " + location : ""}.${correctionNote}${refinedNote} (${breakdown})${note}`;
      $("#jobs-loader").style.display = stillWaiting ? "flex" : "none";
      $("#download-csv-btn").style.display = (!stillWaiting && currentSearchJobs.length) ? "" : "none";
    };
    updateStatus();

    try {
      const res = await fetch(JOBS_API + "/api/scrape-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_term: term,
          location: locationForApi,
          sites: requestedSites,
          hours_old: hoursOld,
          results_wanted: 200,
          timeout_seconds: 280,
          country_indeed: country,
        }),
      });

      if (!res.ok || !res.body) {
        $("#jobs-status").textContent = "Search failed to start (HTTP " + res.status + ").";
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;

          const chunk = JSON.parse(line);

          if (chunk.done) {
            updateStatus();
            continue;
          }

          siteCounts[chunk.site] = chunk.count;
          if (chunk.ok && chunk.jobs.length) {
            const startIndex = currentSearchJobs.length;
            total += chunk.jobs.length;
            currentSearchJobs.push(...chunk.jobs);
            $("#jobs-results").insertAdjacentHTML("beforeend",
              chunk.jobs.map((j, i) => jobCardHtml(j, startIndex + i)).join(""));
          }
          updateStatus();
        }
      }
    } catch (err) {
      $("#jobs-status").textContent = "Couldn't reach the jobs search backend (is it running on localhost:8422?).";
      $("#jobs-loader").style.display = "none";
    }
  }

  function generateResumeForJob(title, description, anchorEl) {
    $("#f-headline").value = title;
    $("#f-headline").classList.remove("mock-value");
    // No scraped description for this listing -- still AI-tailor off just
    // the title rather than falling back to a boilerplate one-liner. Company
    // is deliberately left out: with this little else to go on, the model
    // tends to parrot "at Company" straight into the candidate's own summary
    // instead of treating it as unusable-for-tailoring context.
    const jd = description || `Job title: ${title}`;
    // Always AI-tailor summary/skills to this job (overwriting whatever was
    // there from a previously viewed job) -- that's the whole point of
    // clicking Generate Resume for a specific job.
    $("#f-jd").value = jd;
    generateSummaryAndSkills();
    updateApplyButton();
    showBuildView(anchorEl);
  }

  // ── AI summary + skills generation, from pasted/seeded JD ──

  // FastAPI's own request-validation errors (bad field length/type, before
  // the route body even runs) send `detail` as an array of {msg, loc, ...}
  // objects rather than the plain string our route handlers send -- stringify
  // straight into an Error would render as "[object Object]".
  function extractErrorDetail(data) {
    const d = data && data.detail;
    if (typeof d === "string" && d) return d;
    if (Array.isArray(d) && d.length) {
      return d.map(e => (e && e.msg) || "Invalid request").join("; ");
    }
    return "Request failed";
  }

  // Bumped on every call so a slow response from a job clicked earlier can't
  // land after a later job's request and overwrite its (already-applied)
  // result -- same pattern as docxPreviewGeneration above.
  let summaryGeneration = 0;

  async function generateSummaryAndSkills() {
    const myGeneration = ++summaryGeneration;
    const jd = $("#f-jd").value.trim();
    const statusEl = $("#ai-summary-status");
    const btn = $("#ai-summary-btn");
    if (!jd) {
      statusEl.textContent = "Paste a job description above first.";
      return;
    }
    const jdInput = $("#f-jd");
    btn.disabled = true;
    jdInput.disabled = true;
    // The backend scrapes the page server-side when this is a bare URL
    // (the browser can't -- most job boards block cross-origin fetches).
    const isLink = /^https?:\/\/\S+$/i.test(jd);
    btn.textContent = isLink ? "Reading that link…" : "Generating…";
    statusEl.textContent = "";
    const overlay = $("#ai-generating-overlay");
    $("#ai-generating-text").textContent = isLink ? "✨ Reading that job link…" : "✨ AI is writing your resume…";
    overlay.classList.add("active");
    try {
      const res = await fetch(JOBS_API + "/api/generate-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd,
          name: $("#f-name").value.trim(),
          headline: $("#f-headline").value.trim(),
          skills: flattenSkillGroups(collectSkillGroups(false)),
        }),
      });
      const data = await res.json();
      if (myGeneration !== summaryGeneration) return; // a newer job's request superseded this one
      if (!res.ok) throw new Error(extractErrorDetail(data));
      if (data.title) {
        // Tailoring to a specific job -- the headline should track it, same
        // as clicking "Generate Resume" from a job search result does.
        $("#f-headline").value = data.title;
        $("#f-headline").classList.remove("mock-value");
      }
      $("#f-summary").value = data.summary || "";
      $("#f-summary").classList.remove("mock-value");
      clearMockSkillEntries();
      if ((data.skillGroups || []).length) {
        // Replaces whatever categories were there with the AI's own
        // grouping rather than trying to guess how to merge into existing
        // ones.
        document.getElementById("skills-list").innerHTML = "";
        data.skillGroups.forEach(g => addEntry("skills-list", "skill-category-template", {
          "sc-label": g.label, "sc-items": (g.items || []).join(", "),
        }));
        statusEl.textContent = "";
      } else {
        statusEl.textContent = "Summary updated, but couldn't find specific skills in that description.";
      }
      render();
    } catch (err) {
      if (myGeneration !== summaryGeneration) return; // a newer job's request superseded this one
      // Surface the backend's actual reason (e.g. "that page loads content
      // dynamically") rather than a generic message that hides it.
      statusEl.textContent = err.message || "Couldn't generate a summary right now. Try again in a moment.";
    } finally {
      if (myGeneration !== summaryGeneration) return; // newer request owns the button/overlay state now
      overlay.classList.remove("active");
      btn.disabled = false;
      jdInput.disabled = false;
      btn.textContent = "✨ Generate summary & skills with AI";
    }
  }

  $("#ai-summary-btn").addEventListener("click", () => generateSummaryAndSkills());

  // ── CSV export ──

  function csvCell(v) {
    const s = (v === null || v === undefined) ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function jobsToCsv(jobs) {
    const columns = [
      ["site", "Site"], ["title", "Title"], ["company", "Company"], ["location", "Location"],
      ["job_type", "Job Type"], ["is_remote", "Remote"], ["date_posted", "Date Posted"],
      ["salary_min", "Salary Min"], ["salary_max", "Salary Max"], ["salary_currency", "Currency"],
      ["interval", "Pay Interval"], ["url", "URL"], ["description", "Description"],
    ];
    const header = columns.map(([, label]) => csvCell(label)).join(",");
    const rows = jobs.map(j => columns.map(([key]) => csvCell(j[key])).join(","));
    return [header, ...rows].join("\r\n");
  }

  function downloadCsv() {
    if (!currentSearchJobs.length) return;
    const csv = jobsToCsv(currentSearchJobs);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const safeLabel = currentSearchLabel.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "jobs";
    const a = document.createElement("a");
    a.href = url;
    a.download = `jobs-${safeLabel}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  $("#download-csv-btn").addEventListener("click", downloadCsv);

  $("#job-search-btn").addEventListener("click", runJobSearch);
  $("#job-location").addEventListener("keydown", e => { if (e.key === "Enter") runJobSearch(); });

  // ── Android on-screen keyboard: the hero is vertically centered with vh
  // padding, which doesn't shrink when the keyboard opens on most Android
  // browsers/WebViews -- the focused input can end up hidden behind it.
  // Shrink the hero to the top on focus, and nudge the focused field into
  // view once the keyboard has actually finished animating in. ──
  (function setupKeyboardAdjust() {
    const jobsView = $("#jobs-view");
    const trackedInputs = ["#job-search-term", "#job-location"].map($);
    const isTrackedFocused = () => trackedInputs.includes(document.activeElement);

    trackedInputs.forEach(el => {
      el.addEventListener("focus", () => jobsView.classList.add("kb-open"));
      el.addEventListener("blur", () => {
        setTimeout(() => { if (!isTrackedFocused()) jobsView.classList.remove("kb-open"); }, 50);
      });
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        if (isTrackedFocused()) {
          document.activeElement.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      });
    }
  })();

  // ── Search-term autocomplete (Google-style, suggests against the same
  // job-search dictionary the auto-correct above uses) ──
  const termInput = $("#job-search-term");
  const suggestList = $("#job-term-suggestions");
  let activeSuggestionIndex = -1;

  function currentWordBounds() {
    const value = termInput.value;
    const caret = termInput.selectionStart;
    const start = value.slice(0, caret).search(/\S*$/);
    const endMatch = value.slice(caret).match(/^\S*/);
    const end = caret + (endMatch ? endMatch[0].length : 0);
    return { start, end, word: value.slice(start, end) };
  }

  function renderSuggestions(matches, prefix) {
    if (!matches.length) { hideSuggestions(); return; }
    suggestList.innerHTML = matches.map((m, i) => `
      <li role="option" data-index="${i}" data-word="${escapeHtml(m)}">
        <span class="ac-icon">🔍</span><span><span class="ac-match">${escapeHtml(m.slice(0, prefix.length))}</span>${escapeHtml(m.slice(prefix.length))}</span>
      </li>`).join("");
    suggestList.hidden = false;
    activeSuggestionIndex = -1;
  }
  function hideSuggestions() {
    suggestList.hidden = true;
    suggestList.innerHTML = "";
    activeSuggestionIndex = -1;
  }
  function applySuggestion(word) {
    const { start, end } = currentWordBounds();
    const value = termInput.value;
    const needsSpace = end < value.length && !/\s/.test(value[end]);
    termInput.value = value.slice(0, start) + word + (needsSpace ? " " : "") + value.slice(end);
    const caret = start + word.length + (needsSpace ? 1 : 0);
    termInput.setSelectionRange(caret, caret);
    hideSuggestions();
  }

  termInput.addEventListener("input", () => {
    const { word } = currentWordBounds();
    const prefix = word.toLowerCase();
    if (prefix.length < 2) { hideSuggestions(); return; }
    const matches = JOB_DICTIONARY.filter(w => w.startsWith(prefix) && w !== prefix).slice(0, 6);
    renderSuggestions(matches, prefix);
  });

  termInput.addEventListener("keydown", (e) => {
    const items = suggestList.querySelectorAll("li");
    if (!suggestList.hidden && items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex + 1) % items.length;
        items.forEach((li, i) => li.classList.toggle("active", i === activeSuggestionIndex));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex - 1 + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle("active", i === activeSuggestionIndex));
        return;
      }
      if (e.key === "Enter" && activeSuggestionIndex >= 0) {
        e.preventDefault();
        applySuggestion(items[activeSuggestionIndex].dataset.word);
        return;
      }
      if (e.key === "Escape") { hideSuggestions(); return; }
    }
    if (e.key === "Enter") { hideSuggestions(); runJobSearch(); }
  });

  suggestList.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    applySuggestion(li.dataset.word);
    termInput.focus();
  });
  document.addEventListener("click", (e) => {
    if (!termInput.contains(e.target) && !suggestList.contains(e.target)) hideSuggestions();
  });

  // ── Sample profiles — one picked at random on every load, so a first-time
  // visitor sees a filled-out resume instead of a blank form. ──

  const SAMPLE_PROFILES = [
    {
      name: "Priya Nair", headline: "Frontend Engineer",
      email: "priya.nair@email.com", phone: "+91 98765 43210",
      location: "Bengaluru, India", link: "linkedin.com/in/priyanair",
      summary: "Frontend engineer with 5 years building fast, accessible web apps in React and TypeScript. Enjoys turning ambiguous design specs into clean, maintainable UI code.",
      experience: [
        { "e-title": "Senior Frontend Engineer", "e-company": "Northstar Labs", "e-location": "Bengaluru", "e-start": "Mar 2022", "e-end": "Present",
          "e-bullets": "Led migration of the core dashboard from Angular to React, cutting page load time by 45%\nBuilt a shared component library adopted across 6 product teams\nMentored two junior engineers through their first six months" },
        { "e-title": "Frontend Engineer", "e-company": "Kettle & Co", "e-location": "Pune", "e-start": "Jun 2019", "e-end": "Feb 2022",
          "e-bullets": "Shipped the customer-facing checkout redesign, lifting conversion by 12%\nIntroduced automated visual regression testing, catching UI bugs before release" },
      ],
      education: [
        { "d-degree": "B.Tech, Computer Science", "d-school": "VIT Vellore", "d-location": "Vellore, India", "d-start": "2015", "d-end": "2019" },
      ],
      skills: "React, TypeScript, CSS, Redux, Jest, Figma, REST APIs",
    },
    {
      name: "Marcus Chen", headline: "Product Marketing Manager",
      email: "marcus.chen@email.com", phone: "+1 (415) 555-0192",
      location: "San Francisco, CA", link: "linkedin.com/in/marcuschen",
      summary: "Product marketer who's launched 10+ B2B SaaS features from positioning through GTM. Comfortable pairing with sales, design, and engineering to ship messaging that actually lands.",
      experience: [
        { "e-title": "Product Marketing Manager", "e-company": "Vellum Analytics", "e-location": "Remote", "e-start": "Aug 2021", "e-end": "Present",
          "e-bullets": "Owned GTM for 4 major product launches, driving a combined $2.3M in pipeline\nRebuilt the competitive battlecard process, cutting sales-rep ramp time by a third\nRan quarterly customer interviews that directly shaped the product roadmap" },
        { "e-title": "Marketing Associate", "e-company": "Fielder", "e-location": "Austin, TX", "e-start": "Jul 2018", "e-end": "Jul 2021",
          "e-bullets": "Managed content calendar across blog, email, and social, growing newsletter subs 3x\nCoordinated 5 in-person and virtual customer events" },
      ],
      education: [
        { "d-degree": "B.A., Marketing", "d-school": "University of Texas at Austin", "d-location": "Austin, TX", "d-start": "2014", "d-end": "2018" },
      ],
      skills: "Positioning, GTM Strategy, Competitive Analysis, HubSpot, SQL, A/B Testing",
    },
    {
      name: "Ananya Rao", headline: "Data Analyst",
      email: "ananya.rao@email.com", phone: "+91 90123 45678",
      location: "Hyderabad, India", link: "github.com/ananyarao",
      summary: "Data analyst focused on turning messy operational data into decisions people actually act on. Strong in SQL and Python, comfortable presenting findings straight to leadership.",
      experience: [
        { "e-title": "Data Analyst", "e-company": "Freshbox Logistics", "e-location": "Hyderabad", "e-start": "Jan 2023", "e-end": "Present",
          "e-bullets": "Built a delivery-delay prediction model that cut late shipments by 18%\nAutomated the weekly ops report, saving the team ~6 hours a week\nPartnered with warehouse leads to redesign 3 broken KPI dashboards" },
        { "e-title": "Junior Data Analyst", "e-company": "Clarity Insights", "e-location": "Chennai", "e-start": "Jul 2021", "e-end": "Dec 2022",
          "e-bullets": "Wrote SQL pipelines feeding daily exec dashboards\nSupported A/B test analysis for the growth team" },
      ],
      education: [
        { "d-degree": "B.Sc., Statistics", "d-school": "Loyola College", "d-location": "Chennai, India", "d-start": "2017", "d-end": "2021" },
      ],
      skills: "SQL, Python, Pandas, Tableau, Excel, A/B Testing, Power BI",
    },
  ];

  function fillSampleProfile() {
    const p = SAMPLE_PROFILES[Math.floor(Math.random() * SAMPLE_PROFILES.length)];

    const fields = ["f-name", "f-headline", "f-email", "f-phone", "f-location", "f-link", "f-summary"];
    const values = [p.name, p.headline, p.email, p.phone, p.location, p.link, p.summary];
    fields.forEach((id, i) => {
      const el = $("#" + id);
      el.value = values[i];
      el.classList.add("mock-value");
    });

    p.experience.forEach(data => addEntry("experience-list", "experience-template", data, true));
    addEntry("skills-list", "skill-category-template", { "sc-label": "Skills", "sc-items": p.skills }, true);
    p.education.forEach(data => addEntry("education-list", "education-template", data, true));
  }

  const savedOnLoad = loadResumeData();
  if (hasSavedContent(savedOnLoad)) {
    restoreResumeData(savedOnLoad);
  } else {
    fillSampleProfile();
  }
  render();
  suppressDraftSave = false;
