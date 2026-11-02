// ==UserScript==
// @name         Moodle AI Pilot - Autonomous Multimodal Assistant
// @namespace    moodle.ai.pilot
// @version      1.0.0
// @description  Autonomous LMS evaluation framework: Speech-to-Text listening, Vision, Cloze, and Drag-and-Drop with human pacing
// @match        *://*/*mod/quiz/*
// @match        *://*/*course/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    if (window.moodlePilotLoaded) return;
    window.moodlePilotLoaded = true;

    const BRIDGE_URL = 'http://127.0.0.1:8765/solve';
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const randomRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    let isRunning = false;
    let shouldStop = false;

    function normalizeStr(s) {
        if (!s) return '';
        return String(s)
            .toLowerCase()
            .replace(/[’‘`]/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
    }

    function fetchAsBase64(url) {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    onload: (res) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(res.response);
                    },
                    onerror: () => resolve(null)
                });
            } catch (e) {
                resolve(null);
            }
        });
    }

    async function extractQuestions() {
        const questionBlocks = document.querySelectorAll('.que');
        const extracted = [];

        for (let idx = 0; idx < questionBlocks.length; idx++) {
            const q = questionBlocks[idx];
            const noEl = q.querySelector('.info .no');
            const numText = noEl ? noEl.innerText.replace(/\D/g, '') : String(idx + 1);
            const qNum = parseInt(numText, 10) || (idx + 1);

            const formulation = q.querySelector('.formulation') || q.querySelector('.qtext') || q;
            const clone = formulation.cloneNode(true);

            clone.querySelectorAll('input[type="text"]').forEach((inp, iIdx) => {
                const placeholder = document.createTextNode(` [BLANK_${iIdx + 1}] `);
                inp.parentNode.replaceChild(placeholder, inp);
            });

            clone.querySelectorAll('select').forEach((sel, sIdx) => {
                const placeholder = document.createTextNode(` [SELECT_${sIdx + 1}] `);
                sel.parentNode.replaceChild(placeholder, sel);
            });

            const dropElements = clone.querySelectorAll('.drop, .dropzone, [class*="place"], .target');
            dropElements.forEach((drop, dIdx) => {
                const placeholder = document.createTextNode(` [DROP_${dIdx + 1}] `);
                drop.parentNode.replaceChild(placeholder, drop);
            });

            const qText = clone.innerText.trim();

            const item = {
                question_number: qNum,
                question_id: q.id,
                text: qText,
                type: 'unknown',
                options: [],
                text_fields: [],
                selects: [],
                drag_choices: [],
                images: [],
                audios: []
            };

            const dragItems = Array.from(q.querySelectorAll('.draghome, .dragitems .drag, .drags .drag, [class*="choice"]'));
            const dropZones = Array.from(q.querySelectorAll('.drop, .dropzone, [class*="placeinput"], .target'));

            if (dragItems.length > 0 && dropZones.length > 0) {
                item.type = 'dragdrop';
                const seenChoices = new Set();

                dragItems.forEach((d, dIdx) => {
                    const match = d.className.match(/choice(\d+)/);
                    const choiceNum = match ? match[1] : String(dIdx + 1);
                    const text = d.innerText.trim();

                    if (text && !seenChoices.has(choiceNum)) {
                        seenChoices.add(choiceNum);
                        item.drag_choices.push({
                            choice: choiceNum,
                            text: text,
                            id: d.id
                        });
                    }
                });
            }

            const imgEls = q.querySelectorAll('.formulation img, .qtext img');
            for (const img of imgEls) {
                if (img.src && !img.src.includes('pix.php') && !img.src.includes('icon')) {
                    const b64 = await fetchAsBase64(img.src);
                    if (b64) item.images.push(b64);
                }
            }

            const audioEls = q.querySelectorAll('audio, audio source, a[href*=".mp3"]');
            for (const a of audioEls) {
                const src = a.src || a.getAttribute('src') || (a.tagName === 'A' ? a.href : null);
                if (src) {
                    const b64 = await fetchAsBase64(src);
                    if (b64) item.audios.push(b64);
                }
            }

            const answerRows = q.querySelectorAll('.answer > div, .answer table tr, .answer .r0, .answer .r1');
            if (answerRows.length > 0 && item.type === 'unknown') {
                item.type = 'choice';
                answerRows.forEach((row) => {
                    const inp = row.querySelector('input[type="radio"], input[type="checkbox"]');
                    const lbl = row.querySelector('label, .answernumber + div, .flex-fill');
                    const text = lbl ? lbl.innerText.trim() : row.innerText.trim();
                    if (inp) {
                        item.options.push({
                            id: inp.id,
                            name: inp.name,
                            value: inp.value,
                            text: text
                        });
                    }
                });
            }

            const selectEls = q.querySelectorAll('select');
            if (selectEls.length > 0 && item.type === 'unknown') {
                item.type = 'select';
                selectEls.forEach((sel, sIdx) => {
                    const opts = Array.from(sel.options)
                        .map((o, optIdx) => ({
                            index: optIdx,
                            value: o.value,
                            text: o.text.trim()
                        }))
                        .filter(o => o.value !== '' && o.text !== '');
                    item.selects.push({
                        id: sel.id || '',
                        name: sel.name || '',
                        index: sIdx,
                        options: opts
                    });
                });
            }

            const textInps = q.querySelectorAll('input[type="text"]');
            if (textInps.length > 0 && item.type === 'unknown') {
                item.type = 'text';
                textInps.forEach((inp, tIdx) => {
                    item.text_fields.push({
                        id: inp.id || '',
                        name: inp.name || '',
                        index: tIdx
                    });
                });
            }

            extracted.push(item);
        }

        return extracted;
    }

    async function typeHuman(inputEl, text) {
        inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        inputEl.focus();
        await sleep(randomRange(300, 600));

        inputEl.value = '';
        for (let i = 0; i < text.length; i++) {
            if (shouldStop) break;
            inputEl.value += text[i];
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(randomRange(65, 140));
        }

        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(randomRange(200, 450));
        inputEl.blur();
    }

    function getUnansweredQuestions() {
        const questionBlocks = document.querySelectorAll('.que');
        const unanswered = [];

        questionBlocks.forEach((q, idx) => {
            const noEl = q.querySelector('.info .no');
            const qNum = noEl ? noEl.innerText.replace(/\D/g, '') : String(idx + 1);

            let isFilled = false;

            const checkedRadio = q.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
            if (checkedRadio) isFilled = true;

            const textFields = q.querySelectorAll('input[type="text"]');
            if (textFields.length > 0) {
                isFilled = Array.from(textFields).every(inp => inp.value.trim() !== '');
            }

            const selects = q.querySelectorAll('select');
            if (selects.length > 0) {
                isFilled = Array.from(selects).every(sel => sel.value !== '' && sel.selectedIndex > 0);
            }

            const placeInputs = q.querySelectorAll('input[class*="placeinput"], input[name*="_p"]');
            if (placeInputs.length > 0) {
                isFilled = Array.from(placeInputs).every(inp => inp.value !== '' && inp.value !== '0');
            }

            if (!isFilled) {
                unanswered.push(qNum);
            }
        });

        return unanswered;
    }

    async function fillAnswers(answers, baseDelay, countdownEl) {
        const questions = await extractQuestions();

        for (let i = 0; i < questions.length; i++) {
            if (shouldStop) break;
            const q = questions[i];
            const qNum = q.question_number;
            const ans = answers[qNum] || answers[String(qNum)];

            countdownEl.innerText = `Solving question ${i + 1}/${questions.length}`;

            if (ans !== undefined && ans !== null) {
                const qElem = document.getElementById(q.question_id);
                if (qElem) {
                    qElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await sleep(randomRange(400, 800));

                    // Drag & Drop
                    if (q.drag_choices && q.drag_choices.length > 0) {
                        const ansList = Array.isArray(ans) ? ans : [ans];
                        const domDropZones = Array.from(qElem.querySelectorAll('.drop, .dropzone, [class*="place"]')).filter(el => el.classList.contains('drop') || el.classList.contains('dropzone') || /place\d+/.test(el.className));

                        for (let dIdx = 0; dIdx < ansList.length; dIdx++) {
                            const rawTarget = String(ansList[dIdx]).trim();
                            const targetNorm = normalizeStr(rawTarget);
                            const targetLetter = rawTarget.match(/^([A-Fa-f])[\)\.]/)?.[1]?.toLowerCase();

                            let matchedChoice = q.drag_choices.find(c => {
                                const choiceLetter = c.text.match(/^([A-Fa-f])[\)\.]/)?.[1]?.toLowerCase();
                                if (targetLetter && choiceLetter && targetLetter === choiceLetter) return true;
                                const cNorm = normalizeStr(c.text);
                                return cNorm.includes(targetNorm) || targetNorm.includes(cNorm);
                            });

                            if (!matchedChoice && q.drag_choices[dIdx]) {
                                matchedChoice = q.drag_choices[dIdx];
                            }

                            if (matchedChoice) {
                                const placeIndex = dIdx + 1;

                                const hiddenInp = qElem.querySelector(`input.place${placeIndex}, input[name$="_p${placeIndex}"], input[name*="_sub${placeIndex}"]`);
                                if (hiddenInp) {
                                    hiddenInp.value = matchedChoice.choice;
                                    hiddenInp.dispatchEvent(new Event('input', { bubbles: true }));
                                    hiddenInp.dispatchEvent(new Event('change', { bubbles: true }));
                                }

                                const dragEl = qElem.querySelector(`.draghome.choice${matchedChoice.choice}, .drag.choice${matchedChoice.choice}`)
                                    || Array.from(qElem.querySelectorAll('.draghome, .drag')).find(d => normalizeStr(d.innerText).includes(normalizeStr(matchedChoice.text)));

                                const dropEl = domDropZones[dIdx] || qElem.querySelector(`.drop.place${placeIndex}, .place${placeIndex}.drop, .dropzone.place${placeIndex}`);

                                if (dragEl && dropEl) {
                                    dragEl.focus();
                                    dragEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                    dragEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                    dragEl.click();
                                    await sleep(250);

                                    dropEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                    dropEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                    dropEl.click();
                                    await sleep(350);

                                    if (!dropEl.innerText.trim()) {
                                        const badge = document.createElement('div');
                                        badge.innerText = matchedChoice.text;
                                        badge.style.cssText = 'background: #e2e8f0; color: #1a202c; border: 1px solid #718096; border-radius: 4px; padding: 4px 8px; font-weight: 500; font-size: 13px;';
                                        dropEl.innerHTML = '';
                                        dropEl.appendChild(badge);
                                    }
                                }
                            }
                        }
                    }

                    // Dropdown Selects
                    if (q.selects && q.selects.length > 0) {
                        const ansList = Array.isArray(ans) ? ans : [ans];
                        const domSelects = Array.from(qElem.querySelectorAll('select'));

                        for (let sIdx = 0; sIdx < q.selects.length; sIdx++) {
                            const selMeta = q.selects[sIdx];
                            const selEl = (selMeta.name ? qElem.querySelector(`select[name="${selMeta.name}"]`) : null)
                                || (selMeta.id ? document.getElementById(selMeta.id) : null)
                                || domSelects[sIdx];

                            if (selEl) {
                                const expectedNorm = normalizeStr(ansList[sIdx] || ansList[0]);
                                let matchedOpt = null;

                                for (const opt of selEl.options) {
                                    if (!opt.value || opt.value === '0') continue;
                                    const optNorm = normalizeStr(opt.text);
                                    if (optNorm === expectedNorm || optNorm.includes(expectedNorm) || expectedNorm.includes(optNorm)) {
                                        matchedOpt = opt;
                                        break;
                                    }
                                }

                                if (matchedOpt) {
                                    selEl.focus();
                                    await sleep(randomRange(200, 400));
                                    selEl.selectedIndex = matchedOpt.index;
                                    selEl.value = matchedOpt.value;
                                    selEl.dispatchEvent(new Event('input', { bubbles: true }));
                                    selEl.dispatchEvent(new Event('change', { bubbles: true }));
                                    await sleep(randomRange(200, 350));
                                    selEl.blur();
                                }
                            }
                        }
                    }

                    // Radio choices
                    if (q.options && q.options.length > 0) {
                        let targetOpt = null;
                        let targetWords = [];
                        if (Array.isArray(ans)) {
                            targetWords = ans.map(w => normalizeStr(w));
                        } else {
                            targetWords = normalizeStr(ans).split(/[\/, ]+/).filter(Boolean);
                        }

                        for (const opt of q.options) {
                            const optClean = normalizeStr(opt.text);
                            const allFound = targetWords.every(w => optClean.includes(w));
                            if (allFound) {
                                targetOpt = opt;
                                break;
                            }
                        }

                        if (!targetOpt) {
                            const ansNorm = normalizeStr(ans);
                            targetOpt = q.options.find(o => normalizeStr(o.text).includes(ansNorm) || ansNorm.includes(normalizeStr(o.text)));
                        }

                        if (targetOpt) {
                            const inp = document.getElementById(targetOpt.id);
                            if (inp) {
                                inp.checked = true;
                                inp.dispatchEvent(new Event('change', { bubbles: true }));
                                inp.dispatchEvent(new Event('click', { bubbles: true }));
                            }
                        }
                    }

                    // Text inputs
                    if (q.text_fields && q.text_fields.length > 0) {
                        const ansList = Array.isArray(ans) ? ans : [ans];
                        const domTextInps = Array.from(qElem.querySelectorAll('input[type="text"]'));

                        for (let tIdx = 0; tIdx < q.text_fields.length; tIdx++) {
                            if (shouldStop) break;
                            const fldMeta = q.text_fields[tIdx];
                            const fldEl = (fldMeta.name ? qElem.querySelector(`input[name="${fldMeta.name}"]`) : null)
                                || (fldMeta.id ? document.getElementById(fldMeta.id) : null)
                                || domTextInps[tIdx];

                            const targetVal = String(ansList[tIdx] !== undefined ? ansList[tIdx] : ansList[0]).trim();
                            if (fldEl) {
                                await typeHuman(fldEl, targetVal);
                            }
                        }
                    }
                }
            }

            if (i < questions.length - 1 && !shouldStop) {
                const pauseSec = Math.max(5, baseDelay + randomRange(-3, 5));
                for (let s = pauseSec; s > 0; s--) {
                    if (shouldStop) break;
                    countdownEl.innerText = `Pacing delay before question ${i + 2}: ${s}s...`;
                    await sleep(1000);
                }
            }
        }
    }

    async function advanceToNext(statusEl, countdownEl) {
        let queue = GM_getValue('moodle_queue', []);
        let curIdx = GM_getValue('moodle_cur_idx', 0);
        curIdx++;
        GM_setValue('moodle_cur_idx', curIdx);

        if (curIdx < queue.length) {
            countdownEl.innerText = `Transitioning to quiz ${curIdx + 1}/${queue.length}: ${queue[curIdx].title}`;
            await sleep(2500);
            window.location.href = queue[curIdx].url;
        } else {
            GM_setValue('moodle_autopilot', false);
            statusEl.innerText = 'Completed';
            countdownEl.innerText = 'All section quizzes completed.';
            const sectionUrl = GM_getValue('moodle_section_url', '');
            if (sectionUrl) {
                await sleep(2000);
                window.location.href = sectionUrl;
            }
        }
    }

    async function handleAutoPilot(statusEl, countdownEl, btnStop) {
        const isAuto = GM_getValue('moodle_autopilot', false);
        if (!isAuto) return;

        btnStop.disabled = false;
        const currentPath = window.location.pathname;

        // 1. Quiz intro page
        if (currentPath.includes('/mod/quiz/view.php')) {
            statusEl.innerText = 'Checking quiz status...';
            await sleep(2000);

            const summaryTable = document.querySelector('.quizattemptsummary, .generaltable');
            const tableText = summaryTable ? summaryTable.innerText : '';
            const hasFinishedAttempt = tableText.includes('Завершено') || tableText.includes('Finished') || tableText.includes('Оценка');

            const buttons = Array.from(document.querySelectorAll('form[action*="startattempt.php"] button, form[action*="startattempt.php"] input, .quizstartbuttonbox input, form[action*="attempt.php"] button, form[action*="attempt.php"] input, a[href*="attempt.php"]'));

            let continueBtn = null;
            let startNewBtn = null;

            for (const b of buttons) {
                const val = (b.innerText || b.value || '').trim();
                if (val.includes('Продолжить') || val.includes('Continue')) {
                    continueBtn = b;
                } else if (val.includes('Начать') || val.includes('Пройти тест') || val.includes('Attempt')) {
                    startNewBtn = b;
                }
            }

            if (continueBtn) {
                statusEl.innerText = 'Resuming in-progress attempt...';
                await sleep(randomRange(2000, 3500));
                continueBtn.click();
                return;
            }

            if (hasFinishedAttempt) {
                statusEl.innerText = 'Already completed. Skipping...';
                countdownEl.innerText = 'Existing completed attempt detected.';
                await sleep(2500);
                await advanceToNext(statusEl, countdownEl);
                return;
            }

            if (startNewBtn) {
                statusEl.innerText = 'Starting new attempt...';
                await sleep(randomRange(2500, 4000));
                startNewBtn.click();
                await sleep(1500);
                const modalBtn = document.querySelector('.modal-dialog .btn-primary, button[data-action="save"]');
                if (modalBtn) modalBtn.click();
                return;
            }

            statusEl.innerText = 'No start buttons found. Skipping...';
            await sleep(2000);
            await advanceToNext(statusEl, countdownEl);
        }

        // 2. Quiz attempt page
        else if (currentPath.includes('/mod/quiz/attempt.php')) {
            statusEl.innerText = 'Solving attempt...';
            countdownEl.innerText = 'Extracting questions and media...';
            await sleep(1500);

            const questions = await extractQuestions();
            if (questions.length > 0) {
                try {
                    const response = await fetch(BRIDGE_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ questions: questions })
                    });
                    const data = await response.json();
                    if (data.status === 'ok') {
                        statusEl.innerText = 'Filling answers...';
                        const delay = GM_getValue('moodle_base_delay', 16);
                        await fillAnswers(data.answers, delay, countdownEl);

                        const missed = getUnansweredQuestions();
                        if (missed.length > 0) {
                            statusEl.innerText = 'Safeguard triggered';
                            statusEl.style.color = '#f85149';
                            countdownEl.innerText = `Questions [${missed.join(', ')}] incomplete. Autopilot paused.`;
                            GM_setValue('moodle_autopilot', false);
                            btnStop.disabled = true;
                            return;
                        }

                        await sleep(randomRange(4000, 6000));
                        const nextBtn = document.querySelector('input[name="next"], button[id="responseform_finish"], button.mod_quiz-next-nav');
                        if (nextBtn) {
                            countdownEl.innerText = 'Navigating to submission...';
                            nextBtn.click();
                        }
                    }
                } catch (e) {
                    statusEl.innerText = 'Bridge request error';
                }
            }
        }

        // 3. Quiz summary page
        else if (currentPath.includes('/mod/quiz/summary.php')) {
            statusEl.innerText = 'Submitting attempt...';
            await sleep(randomRange(3500, 6000));

            const finishBtn = document.querySelector('button.btn-finishattempt, input[value*="Отправить всё"], form[action*="processattempt.php"] button, form[action*="processattempt.php"] input[type="submit"]');
            if (finishBtn) {
                finishBtn.click();
                await sleep(2000);
                const confirmModalBtn = document.querySelector('.modal-dialog button.btn-primary, .moodle-dialogue-confirm .btn-primary, input[value*="Отправить всё"]');
                if (confirmModalBtn) confirmModalBtn.click();
            }
        }

        // 4. Review page
        else if (currentPath.includes('/mod/quiz/review.php')) {
            statusEl.innerText = 'Quiz finished. Advancing...';
            await sleep(randomRange(3500, 5000));
            await advanceToNext(statusEl, countdownEl);
        }
    }

    function createUI() {
        const root = document.createElement('div');
        root.id = 'moodle-pilot-panel';
        root.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 320px;
            background: rgba(22, 27, 34, 0.96);
            color: #edf2f7;
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 13px;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            border: 1px solid rgba(255,255,255,0.15);
            z-index: 999999;
            padding: 14px;
            backdrop-filter: blur(8px);
        `;

        const isAuto = GM_getValue('moodle_autopilot', false);
        const curIdx = GM_getValue('moodle_cur_idx', 0);
        const queue = GM_getValue('moodle_queue', []);

        root.innerHTML = `
            <div style="font-weight: 700; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                <span>Moodle AI Pilot</span>
                <span id="ma-status" style="font-size: 11px; color: ${isAuto ? '#3fb950' : '#a0aec0'}; font-weight: normal;">${isAuto ? 'Autopilot Active' : 'Ready'}</span>
            </div>
            <button id="ma-btn-module-auto" style="width: 100%; padding: 9px; margin-bottom: 8px; background: #238636; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 700; font-size: 12px;">[ Start Section Autopilot ]</button>
            <button id="ma-btn-single-auto" style="width: 100%; padding: 7px; margin-bottom: 8px; background: #1f6feb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px;">[ Solve Current Quiz Only ]</button>
            <div style="margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
                <label>Pacing delay between questions:</label>
                <input id="ma-delay-input" type="number" value="${GM_getValue('moodle_base_delay', 16)}" min="5" max="60" style="width: 50px; background: #0d1117; color: #fff; border: 1px solid #30363d; border-radius: 4px; padding: 2px 4px; text-align: center;"> s
            </div>
            <button id="ma-btn-stop" style="width: 100%; padding: 6px; background: #da3633; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;" ${isAuto ? '' : 'disabled'}>[ Stop Autopilot ]</button>
            <div id="ma-countdown" style="margin-top: 10px; font-size: 11px; color: #e3b341; text-align: center; min-height: 16px;">${isAuto && queue.length ? `Quiz ${curIdx + 1}/${queue.length}: ${queue[curIdx]?.title || ''}` : ''}</div>
        `;

        document.body.appendChild(root);

        const statusEl = document.getElementById('ma-status');
        const countdownEl = document.getElementById('ma-countdown');
        const btnModuleAuto = document.getElementById('ma-btn-module-auto');
        const btnSingleAuto = document.getElementById('ma-btn-single-auto');
        const btnStop = document.getElementById('ma-btn-stop');
        const numDelay = document.getElementById('ma-delay-input');

        numDelay.addEventListener('change', () => {
            GM_setValue('moodle_base_delay', parseInt(numDelay.value, 10) || 16);
        });

        btnStop.addEventListener('click', () => {
            shouldStop = true;
            GM_setValue('moodle_autopilot', false);
            statusEl.innerText = 'Stopped';
            statusEl.style.color = '#f85149';
            btnStop.disabled = true;
        });

        btnModuleAuto.addEventListener('click', () => {
            const mainContent = document.querySelector('#region-main, [role="main"], .course-content') || document.body;
            const quizLinks = Array.from(mainContent.querySelectorAll('a[href*="/mod/quiz/view.php"]'));

            const queue = [];
            const seen = new Set();

            quizLinks.forEach(a => {
                const cleanUrl = a.href.split('&')[0];
                const title = a.innerText.trim();
                if (title && !seen.has(cleanUrl)) {
                    seen.add(cleanUrl);
                    queue.push({ title: title, url: a.href });
                }
            });

            if (queue.length === 0) {
                alert('No quiz activities found on the current section page.');
                return;
            }

            GM_setValue('moodle_section_url', window.location.href);
            GM_setValue('moodle_queue', queue);
            GM_setValue('moodle_cur_idx', 0);
            GM_setValue('moodle_autopilot', true);
            GM_setValue('moodle_base_delay', parseInt(numDelay.value, 10) || 16);

            statusEl.innerText = 'Autopilot Started';
            statusEl.style.color = '#3fb950';
            countdownEl.innerText = `Detected ${queue.length} quizzes. Transitioning...`;

            setTimeout(() => {
                window.location.href = queue[0].url;
            }, 1500);
        });

        btnSingleAuto.addEventListener('click', async () => {
            const questions = await extractQuestions();
            if (questions.length === 0) {
                alert('No questions detected on this page.');
                return;
            }

            statusEl.innerText = 'Querying AI...';
            statusEl.style.color = '#58a6ff';
            countdownEl.innerText = 'Analyzing questions & media...';

            try {
                const response = await fetch(BRIDGE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ questions: questions })
                });
                const data = await response.json();
                if (data.status === 'ok') {
                    statusEl.innerText = 'Filling...';
                    const delay = parseInt(numDelay.value, 10) || 16;
                    await fillAnswers(data.answers, delay, countdownEl);

                    const missed = getUnansweredQuestions();
                    if (missed.length > 0) {
                        statusEl.innerText = 'Incomplete';
                        statusEl.style.color = '#f85149';
                        countdownEl.innerText = `Questions [${missed.join(', ')}] uncompleted.`;
                    } else {
                        statusEl.innerText = 'Ready';
                        countdownEl.innerText = 'All questions filled.';
                    }
                }
            } catch (e) {
                alert('Bridge Error: ' + e.message);
            }
        });

        handleAutoPilot(statusEl, countdownEl, btnStop);
    }

    createUI();
})();
