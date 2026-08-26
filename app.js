  const $ = sel => document.querySelector(sel);
  const preview = $("#preview");

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
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

  // Personal info + summary + skills fields
  ["f-name", "f-headline", "f-email", "f-phone", "f-location", "f-link", "f-summary", "f-skills"]
    .forEach(id => document.getElementById(id).addEventListener("input", render));

  $("#download-resume-btn").addEventListener("click", () => window.print());

  $("#clear-btn").addEventListener("click", () => {
    if (!confirm("Clear all fields? This can't be undone.")) return;
    document.querySelectorAll(".form-panel input, .form-panel textarea").forEach(el => {
      el.value = "";
      el.classList.remove("mock-value");
    });
    document.getElementById("experience-list").innerHTML = "";
    document.getElementById("education-list").innerHTML = "";
    render();
    showWizardStep(0);
    exitFinalPreview();
  });

  // ── Wizard: one section of the form visible at a time, instead of the
  // whole thing crammed on screen. Sample data pre-fills every field so
  // nothing starts blank; the first click into a still-unedited field
  // selects its text so typing immediately replaces it. ──

  const wizardSections = () => Array.from(document.querySelectorAll("#form-panel > .section"));

  // Step 1 (Personal Info) has to be filled for real before moving on --
  // otherwise a resume gets built around whatever sample name/email was
  // still sitting there unedited.
  const STEP1_FIELD_IDS = ["f-name", "f-headline", "f-email", "f-phone", "f-location", "f-link"];
  function step1Complete() {
    return STEP1_FIELD_IDS.every(id => {
      const el = $("#" + id);
      return !el.classList.contains("mock-value") && el.value.trim();
    });
  }
  function updateNextButtonState() {
    $("#wizard-next-btn").disabled = wizardStep === 0 && !step1Complete();
  }

  function showWizardStep(i) {
    const sections = wizardSections();
    wizardStep = Math.max(0, Math.min(i, sections.length - 1));
    sections.forEach((s, idx) => { s.style.display = idx === wizardStep ? "" : "none"; });
    $("#wizard-progress").textContent = `Step ${wizardStep + 1} of ${sections.length}`;
    $("#wizard-back-btn").style.visibility = wizardStep === 0 ? "hidden" : "visible";
    $("#wizard-next-btn").textContent = wizardStep === sections.length - 1 ? "Finish → View Resume" : "Next →";
    updateNextButtonState();
  }
  let wizardStep = 0;

  $("#wizard-next-btn").addEventListener("click", () => {
    if ($("#wizard-next-btn").disabled) return;
    const sections = wizardSections();
    if (wizardStep < sections.length - 1) showWizardStep(wizardStep + 1);
    else enterFinalPreview();
  });
  $("#wizard-back-btn").addEventListener("click", () => showWizardStep(wizardStep - 1));

  function enterFinalPreview() {
    $("#form-panel").style.display = "none";
    $("#preview-wrap").style.display = "flex";
  }
  function exitFinalPreview() {
    $("#preview-wrap").style.display = "none";
    $("#form-panel").style.display = "";
  }
  $("#edit-resume-btn").addEventListener("click", () => {
    exitFinalPreview();
    showWizardStep(0);
  });

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

  // First focus on a sample-filled field clears the placeholder text so
  // it's a clean slate to type into, not something to select-and-overtype.
  // Capture phase because focus doesn't bubble.
  document.getElementById("form-panel").addEventListener("focus", (e) => {
    const el = e.target;
    if (el.classList && el.classList.contains("mock-value")) {
      el.value = "";
      el.classList.remove("mock-value");
      render();
    }
  }, true);

  // ── Upload an existing resume: extract its text and drop it into Summary.
  // No reliable way to auto-sort arbitrary resume text into name/experience/
  // education fields without a real parsing service, so this deliberately
  // doesn't pretend to -- it just saves retyping, review/reorganize by hand. ──

  let pdfJsLoadPromise = null;

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    if (pdfJsLoadPromise) return pdfJsLoadPromise;
    pdfJsLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.js";
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";
        resolve();
      };
      script.onerror = () => reject(new Error("Couldn't load the PDF reader (no internet?)."));
      document.head.appendChild(script);
    });
    return pdfJsLoadPromise;
  }

  async function extractPdfText(file) {
    await loadPdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(" ") + "\n\n";
    }
    return text.trim();
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

  $("#resume-upload-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadStatus("Reading " + file.name + "…", true);

    try {
      let text;
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        text = await extractPdfText(file);
      } else if (file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt")) {
        text = await readTextFile(file);
      } else {
        setUploadStatus("Only PDF or .txt files can be auto-read -- fill the form manually for other formats.", false);
        return;
      }

      if (!text || !text.trim()) {
        setUploadStatus("Couldn't find any text in that file (is it a scanned image?). Fill the form manually instead.", false);
        return;
      }

      const summaryEl = $("#f-summary");
      const note = "--- Extracted from " + file.name + " -- review and copy details into the right steps below ---\n\n";
      summaryEl.value = note + text.slice(0, 4000);
      summaryEl.classList.remove("mock-value");
      render();
      setUploadStatus("Extracted " + file.name + " -- available in the Summary step (Step 2) for you to review.", true);
    } catch (err) {
      setUploadStatus(err.message || "Couldn't extract text from that file.", false);
    }
  });

  // ── Render preview from current form state ──

  function render() {
    const name = $("#f-name").value.trim();
    const headline = $("#f-headline").value.trim();
    const email = $("#f-email").value.trim();
    const phone = $("#f-phone").value.trim();
    const location = $("#f-location").value.trim();
    const link = $("#f-link").value.trim();
    const summary = $("#f-summary").value.trim();
    const skills = $("#f-skills").value.split(",").map(s => s.trim()).filter(Boolean);

    const contactParts = [email, phone, location, link].filter(Boolean);

    const experience = [...document.querySelectorAll('#experience-list .entry')].map(e => ({
      title: e.querySelector(".e-title").value.trim(),
      company: e.querySelector(".e-company").value.trim(),
      location: e.querySelector(".e-location").value.trim(),
      start: e.querySelector(".e-start").value.trim(),
      end: e.querySelector(".e-end").value.trim(),
      bullets: e.querySelector(".e-bullets").value.split("\n").map(s => s.trim()).filter(Boolean),
    }));

    const education = [...document.querySelectorAll('#education-list .entry')].map(e => ({
      degree: e.querySelector(".d-degree").value.trim(),
      school: e.querySelector(".d-school").value.trim(),
      location: e.querySelector(".d-location").value.trim(),
      start: e.querySelector(".d-start").value.trim(),
      end: e.querySelector(".d-end").value.trim(),
    }));

    let html = "";

    html += `<div class="r-name">${escapeHtml(name) || '<span class="r-empty">Your Name</span>'}</div>`;
    if (headline) html += `<div class="r-headline">${escapeHtml(headline)}</div>`;
    if (contactParts.length) html += `<div class="r-contact">${contactParts.map(escapeHtml).join(" &nbsp;·&nbsp; ")}</div>`;

    if (summary) {
      html += `<div class="r-section"><h3>Summary</h3><div class="r-summary">${escapeHtml(summary)}</div></div>`;
    }

    if (experience.length) {
      html += `<div class="r-section"><h3>Experience</h3>`;
      experience.forEach(e => {
        if (!e.title && !e.company) return;
        html += `<div class="r-item">
          <div class="r-item-top">
            <div>
              <div class="r-item-title">${escapeHtml(e.title)}</div>
              <div class="r-item-sub">${escapeHtml(e.company)}${e.location ? " — " + escapeHtml(e.location) : ""}</div>
            </div>
            <div class="r-item-date">${escapeHtml([e.start, e.end].filter(Boolean).join(" – "))}</div>
          </div>
          ${e.bullets.length ? `<ul class="r-bullets">${e.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}
        </div>`;
      });
      html += `</div>`;
    }

    if (education.length) {
      html += `<div class="r-section"><h3>Education</h3>`;
      education.forEach(e => {
        if (!e.degree && !e.school) return;
        html += `<div class="r-item">
          <div class="r-item-top">
            <div>
              <div class="r-item-title">${escapeHtml(e.degree)}</div>
              <div class="r-item-sub">${escapeHtml(e.school)}${e.location ? " — " + escapeHtml(e.location) : ""}</div>
            </div>
            <div class="r-item-date">${escapeHtml([e.start, e.end].filter(Boolean).join(" – "))}</div>
          </div>
        </div>`;
      });
      html += `</div>`;
    }

    if (skills.length) {
      html += `<div class="r-section"><h3>Skills</h3><div class="r-skills">${skills.map(s => `<span class="tag">${escapeHtml(s)}</span>`).join("")}</div></div>`;
    }

    preview.innerHTML = html;

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

    const dataOut = {
      name: realVal($("#f-name")),
      headline: realVal($("#f-headline")),
      email: realVal($("#f-email")),
      phone: realVal($("#f-phone")),
      location: realVal($("#f-location")),
      link: realVal($("#f-link")),
      summary: realVal($("#f-summary")),
      skills: $("#f-skills").classList.contains("mock-value") ? "" : $("#f-skills").value,
      experience: realExperience,
      education: realEducation,
    };
    saveResumeData(dataOut);
    if (!suppressDraftSave) scheduleDraftSave(dataOut);
    updateNextButtonState();
  }

  // ── Persistence: everything typed into the wizard auto-saves to this
  // browser's localStorage on every change, and survives reload/reopen.
  // Export/Import give a copy you fully control (a real file, not tied to
  // this browser/device). ──

  const RESUME_DATA_KEY = "resume_builder_data_v1";

  function saveResumeData(data) {
    localStorage.setItem(RESUME_DATA_KEY, JSON.stringify(data));
  }

  function loadResumeData() {
    const raw = localStorage.getItem(RESUME_DATA_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── Auto-save to the backend as the visitor types (disclosed at the top
  // of the wizard, before the first field). Debounced so it's one request
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
    $("#f-skills").value = data.skills || "";

    (data.experience || []).forEach(e => addEntry("experience-list", "experience-template", {
      "e-title": e.title, "e-company": e.company, "e-location": e.location,
      "e-start": e.start, "e-end": e.end, "e-bullets": (e.bullets || []).join("\n"),
    }));
    (data.education || []).forEach(e => addEntry("education-list", "education-template", {
      "d-degree": e.degree, "d-school": e.school, "d-location": e.location,
      "d-start": e.start, "d-end": e.end,
    }));
  }

  // ── View switching (Jobs is the homepage; Build Resume is reached from a
  // job result's "Generate Resume" button, or the back link once there) ──

  const JOBS_API = "https://13-126-187-97.sslip.io";
  let currentSearchJobs = [];
  let currentSearchLabel = "jobs";
  let lastSearchTerm = "";

  function showBuildView() {
    $("#build-view").style.display = "";
    $("#jobs-view").style.display = "none";
    exitFinalPreview();
    showWizardStep(0);
  }

  function showJobsView() {
    $("#jobs-view").style.display = "";
    $("#build-view").style.display = "none";
  }

  $("#back-to-jobs-btn").addEventListener("click", showJobsView);

  // ── Jobs search ──

  function escapeAttr(s) {
    return (s || "").replace(/"/g, "&quot;");
  }

  const SITE_LABELS = { indeed: "Indeed", linkedin: "LinkedIn", glassdoor: "Glassdoor", zip_recruiter: "ZipRecruiter", google: "Google", naukri: "Naukri", simplyhired: "SimplyHired" };

  function jobCardHtml(j) {
    const dTitle = escapeAttr(j.title);
    const dCompany = escapeAttr(j.company);
    const dSite = escapeAttr(j.site);
    const dUrl = escapeAttr(j.url);
    const dAttrs = `data-job-title="${dTitle}" data-job-company="${dCompany}" data-job-site="${dSite}" data-job-url="${dUrl}"`;
    return `
      <div class="job-card">
        <div class="job-card-top">
          <div>
            ${j.url
              ? `<a class="job-title" data-click-action="open_title" ${dAttrs} href="${dUrl}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>`
              : `<div class="job-title">${escapeHtml(j.title)}</div>`}
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
    const job = {
      title: el.dataset.jobTitle || "",
      company: el.dataset.jobCompany || "",
      site: el.dataset.jobSite || "",
      url: el.dataset.jobUrl || "",
    };
    logJobClick(el.dataset.clickAction, job);
    if (el.dataset.clickAction === "generate_resume") {
      const full = currentSearchJobs.find(j =>
        j.title === job.title && j.company === job.company && j.url === job.url);
      generateResumeForJob(job.title, job.company, full ? full.description : "");
    } else if (el.dataset.clickAction === "share_job") {
      shareJob(job, el);
    }
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

    $("#jobs-status").textContent = `Searching jobs posted in ${hoursLabel}…`;
    $("#jobs-results").innerHTML = "";
    $("#jobs-loader").style.display = "flex";
    $("#download-csv-btn").style.display = "none";

    currentSearchJobs = [];
    currentSearchLabel = term + (location ? " in " + location : "");
    lastSearchTerm = term;
    const requestedSites = ["indeed", "linkedin", "glassdoor", "zip_recruiter", "google", "naukri", "simplyhired"];
    const siteCounts = Object.fromEntries(requestedSites.map(s => [s, null])); // null = still running
    let total = 0;

    const updateStatus = () => {
      const breakdown = requestedSites
        .map(s => `${SITE_LABELS[s]}: ${siteCounts[s] === null ? "…" : siteCounts[s]}`)
        .join(", ");
      const stillWaiting = requestedSites.some(s => siteCounts[s] === null);
      const note = stillWaiting ? " LinkedIn is usually the slowest — can take up to a minute, keep this open." : "";
      const correctionNote = correctedFrom ? ` (auto-corrected from "${correctedFrom}")` : "";
      $("#jobs-status").textContent = `${total} result${total === 1 ? "" : "s"} posted in ${hoursLabel} so far for "${term}"${location ? " in " + location : ""}.${correctionNote} (${breakdown})${note}`;
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
            total += chunk.jobs.length;
            currentSearchJobs.push(...chunk.jobs);
            $("#jobs-results").insertAdjacentHTML("beforeend", chunk.jobs.map(jobCardHtml).join(""));
          }
          updateStatus();
        }
      }
    } catch (err) {
      $("#jobs-status").textContent = "Couldn't reach the jobs search backend (is it running on localhost:8422?).";
      $("#jobs-loader").style.display = "none";
    }
  }

  function generateResumeForJob(title, company, description) {
    $("#f-headline").value = title;
    // Don't clobber a summary the person already wrote -- only seed one if it's empty.
    const summaryEl = $("#f-summary");
    if (!summaryEl.value.trim()) {
      summaryEl.value = company
        ? `Aiming for the ${title} role at ${company}.`
        : `Aiming for a ${title} role.`;
    }
    if (description) $("#f-jd").value = description;
    render();
    showBuildView();
  }

  // ── AI summary generation (step 2), from pasted/seeded JD ──

  $("#ai-summary-btn").addEventListener("click", async () => {
    const jd = $("#f-jd").value.trim();
    const statusEl = $("#ai-summary-status");
    const btn = $("#ai-summary-btn");
    if (!jd) {
      statusEl.textContent = "Paste a job description above first.";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Generating…";
    statusEl.textContent = "";
    try {
      const res = await fetch(JOBS_API + "/api/generate-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd,
          name: $("#f-name").value.trim(),
          headline: $("#f-headline").value.trim(),
          skills: $("#f-skills").value.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Request failed");
      $("#f-summary").value = data.summary || "";
      render();
      statusEl.textContent = "";
    } catch (err) {
      statusEl.textContent = "Couldn't generate a summary right now. Try again in a moment.";
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ Generate summary with AI";
    }
  });

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

    const fields = ["f-name", "f-headline", "f-email", "f-phone", "f-location", "f-link", "f-summary", "f-skills"];
    const values = [p.name, p.headline, p.email, p.phone, p.location, p.link, p.summary, p.skills];
    fields.forEach((id, i) => {
      const el = $("#" + id);
      el.value = values[i];
      el.classList.add("mock-value");
    });

    p.experience.forEach(data => addEntry("experience-list", "experience-template", data, true));
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
