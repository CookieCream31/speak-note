(() => {
  function formatTimestamp(seconds) {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainder = totalSeconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function characterIndexFromPoint(textElement, clientX, clientY) {
    let offsetNode = null;
    let offset = 0;

    if (typeof document.caretPositionFromPoint === "function") {
      const position = document.caretPositionFromPoint(clientX, clientY);
      offsetNode = position?.offsetNode || null;
      offset = position?.offset || 0;
    } else if (typeof document.caretRangeFromPoint === "function") {
      const position = document.caretRangeFromPoint(clientX, clientY);
      offsetNode = position?.startContainer || null;
      offset = position?.startOffset || 0;
    }

    if (!offsetNode || !textElement.contains(offsetNode)) return null;

    try {
      const prefix = document.createRange();
      prefix.setStart(textElement, 0);
      prefix.setEnd(offsetNode, offset);
      return Array.from(prefix.toString()).length;
    } catch {
      return null;
    }
  }

  function initializePlayer(root) {
    if (root.dataset.playerReady === "true") return;

    const media = root.querySelector("[data-meeting-media]");
    const status = root.querySelector("[data-player-status]");
    const transcriptDocument = root.querySelector("[data-transcript-document]");
    const followScrollContainer = findScrollableAncestor(transcriptDocument);
    const followStatus = root.querySelector("[data-follow-status]");
    const followResume = root.querySelector("[data-follow-resume]");
    const timelineElement = root.querySelector("[data-transcript-timeline]");
    const turnElements = Array.from(root.querySelectorAll("[data-transcript-turn]"));
    const chapterOutput = root.querySelector("[data-current-chapter]");
    const chapterElements = Array.from(root.querySelectorAll("[data-chapter-segment]"));
    const chapterListItems = Array.from(root.querySelectorAll("[data-chapter-list-item]"));
    const customControls = root.querySelector("[data-custom-media-controls]");
    const mediaStage = root.querySelector("[data-media-stage]");
    const playToggle = root.querySelector("[data-play-toggle]");
    const playIcon = root.querySelector("[data-play-icon]");
    const playLabel = root.querySelector("[data-play-label]");
    const mediaTimeOutput = root.querySelector("[data-media-time]");
    const volumeToggle = root.querySelector("[data-volume-toggle]");
    const volumeIcon = root.querySelector("[data-volume-icon]");
    const volumeSlider = root.querySelector("[data-volume-slider]");
    const fullscreenToggle = root.querySelector("[data-fullscreen-toggle]");
    const playbackRate = root.querySelector("[data-playback-rate]");
    const playbackRateValue = root.querySelector("[data-playback-rate-value]");
    const subtitleOverlay = root.querySelector("[data-subtitle-overlay]");
    const subtitleSpeaker = root.querySelector("[data-subtitle-speaker]");
    const subtitleText = root.querySelector("[data-subtitle-text]");
    const subtitleToggle = root.querySelector("[data-subtitle-toggle]");
    const subtitleCueElements = Array.from(root.querySelectorAll("[data-subtitle-cue]"));
    const skipButtons = Array.from(root.querySelectorAll("[data-skip-seconds]"));
    const declaredDurationMs = Number(root.dataset.mediaDurationMs);
    if (!(media instanceof HTMLMediaElement) || !timelineElement) return;

    let compactTimeline;
    try {
      compactTimeline = JSON.parse(timelineElement.textContent || "[]");
    } catch {
      if (status) status.textContent = "文字起こし時刻を読み込めませんでした";
      return;
    }

    if (customControls instanceof HTMLElement && media instanceof HTMLVideoElement) {
      media.controls = false;
    }

    const turns = turnElements.map((element, turnIndex) => {
      const after = element.querySelector("[data-karaoke-after]");
      return {
        element,
        textElement: element.querySelector("[data-transcript-text]"),
        before: element.querySelector("[data-karaoke-before]"),
        highlighted: element.querySelector("[data-karaoke-highlight]"),
        after,
        characters: Array.from(after?.textContent || ""),
        words: [],
        turnIndex,
        renderedStart: -1,
        renderedCount: 0,
      };
    });
    const words = [];
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex];
      const rows = Array.isArray(compactTimeline[turnIndex]) ? compactTimeline[turnIndex] : [];
      let characterOffset = 0;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 3) continue;
        const [startMs, endMs, characterLength] = row.map(Number);
        if (
          !Number.isFinite(startMs)
          || !Number.isFinite(endMs)
          || !Number.isInteger(characterLength)
          || characterLength <= 0
        ) {
          continue;
        }
        const word = {
          startMs,
          endMs: Math.max(startMs, endMs),
          charStart: characterOffset,
          charEnd: characterOffset + characterLength,
          turn,
        };
        characterOffset = word.charEnd;
        turn.words.push(word);
        words.push(word);
      }
    }

    const chapters = chapterElements
      .map((element) => ({
        element,
        progress: element.querySelector("[data-chapter-progress]"),
        title: element.getAttribute("data-chapter-title") || "チャプター",
        startMs: Number(element.getAttribute("data-chapter-start-ms")),
        declaredEndMs: Number(element.getAttribute("data-chapter-end-ms")),
        timelineStartMs: 0,
        timelineEndMs: 0,
      }))
      .filter((chapter) => Number.isFinite(chapter.startMs) && chapter.startMs >= 0)
      .sort((left, right) => left.startMs - right.startMs);

    const subtitleCues = subtitleCueElements
      .map((element) => ({
        startMs: Number(element.getAttribute("data-subtitle-start-ms")),
        endMs: Number(element.getAttribute("data-subtitle-end-ms")),
        speakerId: element.getAttribute("data-subtitle-speaker-id") || null,
        speakerName: element.getAttribute("data-subtitle-speaker-name") || "",
        text: element.textContent?.trim() || "",
      }))
      .filter((cue) => Number.isFinite(cue.startMs)
        && Number.isFinite(cue.endMs)
        && cue.endMs > cue.startMs
        && cue.text)
      .sort((left, right) => left.startMs - right.startMs);

    root.dataset.playerReady = "true";
    root.addEventListener("click", (event) => {
      if (event.detail === 0 || !(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (button && root.contains(button)) button.blur();
    }, true);

    let activeIndex = -1;
    let activeSubtitleIndex = -1;
    let subtitlesEnabled = root.dataset.subtitlesEnabled === "true" && subtitleCues.length > 0;
    let pendingSeekSeconds = null;
    let animationFrame = null;
    let autoFollowPaused = false;
    let programmaticScrollUntil = 0;
    let videoControlsTimer = null;
    let lastFollowedCharacter = "";
    let lastFollowCheck = 0;
    let transcriptVisibilityObserver = null;
    const mediaLabel = root.dataset.mediaKind === "video" ? "動画" : "音声";
    const transcriptPanel = transcriptDocument instanceof HTMLElement
      ? transcriptDocument.closest("[role=tabpanel]")
      : null;
    const canAutoHideVideoControls = media instanceof HTMLVideoElement
      && customControls instanceof HTMLElement
      && mediaStage instanceof HTMLElement
      && typeof window.matchMedia === "function"
      && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    function setStatus(message) {
      if (status && status.textContent !== message) status.textContent = message;
    }

    function readyMessage() {
      return words.length > 0
        ? "単語・文字をクリックすると、その位置から再生します"
        : `${mediaLabel}を再生できます`;
    }

    function clearVideoControlsTimer() {
      if (videoControlsTimer !== null) window.clearTimeout(videoControlsTimer);
      videoControlsTimer = null;
    }

    function hideVideoControls() {
      clearVideoControlsTimer();
      if (
        customControls instanceof HTMLElement
        && (
          root.querySelector('[data-player-settings][data-open="true"]')
          || customControls.matches(":hover")
          || customControls.contains(document.activeElement)
        )
      ) {
        showVideoControls();
        return;
      }
      if (canAutoHideVideoControls && mediaStage instanceof HTMLElement) {
        mediaStage.dataset.controlsVisible = "false";
      }
    }

    function showVideoControls() {
      if (!(mediaStage instanceof HTMLElement) || !(media instanceof HTMLVideoElement)) return;
      clearVideoControlsTimer();
      mediaStage.dataset.controlsVisible = "true";
      if (canAutoHideVideoControls) {
        videoControlsTimer = window.setTimeout(hideVideoControls, 2500);
      }
    }

    function transcriptIsVisible() {
      return transcriptDocument instanceof HTMLElement
        && transcriptDocument.offsetParent !== null;
    }

    function updateAutoFollowControl() {
      if (followStatus) {
        followStatus.textContent = autoFollowPaused
          ? "自動スクロールを一時停止しました"
          : "再生位置を自動追従します";
      }
      if (followResume instanceof HTMLButtonElement) {
        followResume.hidden = !autoFollowPaused;
      }
    }

    function shouldAutoFollow() {
      return !autoFollowPaused;
    }

    function followPlaybackPosition(currentMs, force = false) {
      if (!shouldAutoFollow() || !transcriptIsVisible()) return;
      const anchor = findPlaybackAnchor(currentMs);
      if (!anchor) return;
      const now = performance.now();
      if (!force && (now - lastFollowCheck < 250 || now < programmaticScrollUntil)) return;
      lastFollowCheck = now;
      const turn = anchor.turn;
      const progress = Math.min(1, Math.max(0, (currentMs - anchor.startMs) / Math.max(1, anchor.endMs - anchor.startMs)));
      const characterIndex = anchor.charStart + Math.min(anchor.charEnd - anchor.charStart - 1,
        Math.floor(progress * (anchor.charEnd - anchor.charStart)));
      const key = `${turn.turnIndex}:${characterIndex}`;
      if (!force && key === lastFollowedCharacter) return;
      lastFollowedCharacter = key;
      scrollToReadingPosition(turn, characterIndex, force);
    }

    if (transcriptPanel instanceof HTMLElement) {
      transcriptVisibilityObserver = new MutationObserver(() => {
        if (!transcriptIsVisible()) return;
        followPlaybackPosition(media.currentTime * 1000, true);
      });
      transcriptVisibilityObserver.observe(transcriptPanel, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }

    function pauseAutoFollow() {
      if (autoFollowPaused || media.paused || !transcriptIsVisible()) return;
      autoFollowPaused = true;
      updateAutoFollowControl();
    }

    function mediaDurationMs() {
      if (Number.isFinite(media.duration) && media.duration > 0) return media.duration * 1000;
      return Number.isFinite(declaredDurationMs) && declaredDurationMs > 0
        ? declaredDurationMs
        : 0;
    }

    function updateMediaControls() {
      const durationMs = mediaDurationMs();
      const durationSeconds = durationMs > 0 ? durationMs / 1000 : 0;
      if (mediaTimeOutput) {
        const durationLabel = durationSeconds > 0 ? formatTimestamp(durationSeconds) : "--:--";
        mediaTimeOutput.textContent = `${formatTimestamp(media.currentTime)} / ${durationLabel}`;
      }

      const action = media.paused ? "再生" : "一時停止";
      if (playToggle) playToggle.setAttribute("aria-label", action);
      if (playLabel) playLabel.textContent = action;
      if (playToggle) playToggle.setAttribute("data-paused", String(media.paused));
      if (playIcon && !playIcon.hasAttribute("data-vector-play-icon")) {
        playIcon.textContent = media.paused ? "▶" : "❚❚";
      }

      const muted = media.muted || media.volume === 0;
      if (volumeToggle) {
        volumeToggle.setAttribute("aria-label", muted ? "ミュート解除" : "ミュート");
        volumeToggle.setAttribute("aria-pressed", String(muted));
        volumeToggle.setAttribute("data-muted", String(muted));
      }
      if (
        volumeIcon
        && !volumeIcon.hasAttribute("data-vector-volume-icon")
      ) {
        volumeIcon.textContent = muted ? "🔇" : "🔊";
      }
      if (volumeSlider instanceof HTMLInputElement) {
        const effectiveVolume = muted ? 0 : media.volume;
        volumeSlider.value = String(effectiveVolume);
        volumeSlider.setAttribute(
          "aria-valuetext",
          muted ? "ミュート" : `${Math.round(effectiveVolume * 100)}%`,
        );
      }

      if (fullscreenToggle) {
        const isFullscreen = document.fullscreenElement === mediaStage;
        fullscreenToggle.setAttribute("aria-label", isFullscreen ? "全画面表示を終了" : "全画面表示");
      }
    }

    function updateSubtitleControl() {
      if (!(subtitleToggle instanceof HTMLButtonElement)) return;
      subtitleToggle.disabled = subtitleCues.length === 0;
      subtitleToggle.setAttribute("aria-pressed", String(subtitlesEnabled));
      subtitleToggle.setAttribute(
        "aria-label",
        subtitleCues.length === 0
          ? "利用できる字幕がありません"
          : subtitlesEnabled
            ? "字幕を非表示"
            : "字幕を表示",
      );
    }

    function findActiveSubtitleIndex(currentMs) {
      let low = 0;
      let high = subtitleCues.length - 1;
      let candidate = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (subtitleCues[middle].startMs <= currentMs) {
          candidate = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return candidate >= 0 && currentMs < subtitleCues[candidate].endMs
        ? candidate
        : -1;
    }

    function renderSubtitle(currentMs) {
      if (!(subtitleOverlay instanceof HTMLElement)) return;
      const nextIndex = subtitlesEnabled ? findActiveSubtitleIndex(currentMs) : -1;
      if (nextIndex === activeSubtitleIndex) return;
      activeSubtitleIndex = nextIndex;

      const cue = nextIndex >= 0 ? subtitleCues[nextIndex] : null;
      subtitleOverlay.hidden = !cue;
      if (subtitleSpeaker) subtitleSpeaker.textContent = cue?.speakerName || "";
      if (subtitleText) subtitleText.textContent = cue?.text || "";
    }

    function toggleSubtitles() {
      if (subtitleCues.length === 0) return;
      subtitlesEnabled = !subtitlesEnabled;
      root.dataset.subtitlesEnabled = String(subtitlesEnabled);
      updateSubtitleControl();
      renderSubtitle(media.currentTime * 1000);
    }

    function handleSpeakerRenamed(event) {
      if (!root.isConnected) {
        window.removeEventListener("speak-note:speaker-renamed", handleSpeakerRenamed);
        return;
      }
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail;
      if (
        !detail
        || typeof detail.speakerId !== "string"
        || typeof detail.speakerName !== "string"
      ) {
        return;
      }
      let changed = false;
      for (const cue of subtitleCues) {
        if (cue.speakerId !== detail.speakerId) continue;
        cue.speakerName = detail.speakerName;
        changed = true;
      }
      if (!changed) return;
      activeSubtitleIndex = -2;
      renderSubtitle(media.currentTime * 1000);
    }

    function layoutChapters() {
      const durationMs = mediaDurationMs();
      if (durationMs <= 0 || chapters.length === 0) return;

      for (let index = 0; index < chapters.length; index += 1) {
        const chapter = chapters[index];
        const nextChapter = chapters[index + 1];
        const startMs = index === 0 ? 0 : Math.min(durationMs, chapter.startMs);
        const inferredEndMs = nextChapter
          ? Math.min(durationMs, nextChapter.startMs)
          : durationMs;
        const declaredEndMs = Number.isFinite(chapter.declaredEndMs)
          ? Math.min(durationMs, chapter.declaredEndMs)
          : durationMs;
        const endMs = Math.max(startMs, inferredEndMs || declaredEndMs);

        chapter.timelineStartMs = startMs;
        chapter.timelineEndMs = endMs;
        chapter.element.style.left = `${(startMs / durationMs) * 100}%`;
        chapter.element.style.width = `${((endMs - startMs) / durationMs) * 100}%`;
        chapter.element.hidden = endMs <= startMs;
      }
    }

    function renderChapters(currentMs) {
      if (chapters.length === 0) return;
      if (chapters[0].timelineEndMs <= 0) layoutChapters();

      let activeChapter = chapters[0];
      let activeProgress = 0;
      for (const chapter of chapters) {
        const span = Math.max(1, chapter.timelineEndMs - chapter.timelineStartMs);
        const progress = Math.min(1, Math.max(0, (currentMs - chapter.timelineStartMs) / span));
        if (chapter.progress instanceof HTMLElement) {
          chapter.progress.style.width = `${progress * 100}%`;
        }
        const isActive = currentMs >= chapter.timelineStartMs
          && (currentMs < chapter.timelineEndMs || chapter === chapters.at(-1));
        chapter.element.toggleAttribute("aria-current", isActive);
        if (isActive) {
          activeChapter = chapter;
          activeProgress = progress;
        }
      }

      // The chapter list beside the player mirrors the active chapter and its progress.
      for (const item of chapterListItems) {
        const isActive = Number(item.getAttribute("data-chapter-list-start-ms")) === activeChapter.startMs;
        item.toggleAttribute("aria-current", isActive);
        const bar = item.querySelector("[data-chapter-list-progress]");
        if (bar instanceof HTMLElement) bar.style.width = isActive ? `${activeProgress * 100}%` : "0%";
      }

      const label = `${activeChapter.title} · ${formatTimestamp(activeChapter.startMs / 1000)}`;
      if (chapterOutput && chapterOutput.textContent !== label) chapterOutput.textContent = label;
    }

    function findActiveWord(currentMs) {
      let low = 0;
      let high = words.length - 1;
      let candidate = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (words[middle].startMs <= currentMs) {
          candidate = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (candidate >= 0 && currentMs < words[candidate].endMs) return candidate;
      return -1;
    }

    function findPlaybackAnchor(currentMs) {
      let low = 0;
      let high = words.length - 1;
      let candidate = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (words[middle].startMs <= currentMs) {
          candidate = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (candidate >= 0) return words[candidate];
      return words[0] || null;
    }

    function findWordAtCharacter(turn, characterIndex) {
      let low = 0;
      let high = turn.words.length - 1;
      let candidate = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (turn.words[middle].charStart <= characterIndex) {
          candidate = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (candidate >= 0 && characterIndex < turn.words[candidate].charEnd) {
        return turn.words[candidate];
      }
      return null;
    }

    function renderKaraoke(word, currentMs) {
      const turn = word.turn;
      const duration = Math.max(1, word.endMs - word.startMs);
      const progress = Math.min(1, Math.max(0, (currentMs - word.startMs) / duration));
      const wordLength = Math.max(1, word.charEnd - word.charStart);
      const count = Math.min(wordLength, Math.max(1, Math.ceil(progress * wordLength)));
      if (turn.renderedStart === word.charStart && turn.renderedCount === count) return;

      turn.renderedStart = word.charStart;
      turn.renderedCount = count;
      if (turn.before) turn.before.textContent = turn.characters.slice(0, word.charStart).join("");
      if (turn.highlighted) {
        turn.highlighted.textContent = turn.characters
          .slice(word.charStart, word.charStart + count)
          .join("");
      }
      if (turn.after) turn.after.textContent = turn.characters.slice(word.charStart + count).join("");
    }

    function resetKaraoke(turn) {
      if (turn.renderedStart < 0) return;
      turn.renderedStart = -1;
      turn.renderedCount = 0;
      if (turn.before) turn.before.textContent = "";
      if (turn.highlighted) turn.highlighted.textContent = "";
      if (turn.after) turn.after.textContent = turn.characters.join("");
    }

    function findScrollableAncestor(element) {
      for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return node;
      }
      return null;
    }

    function scrollToReadingPosition(turn, characterIndex, force) {
      let bounds = turn.textElement?.getBoundingClientRect();
      let remaining = characterIndex;
      // Resolve against all spans, including pauses where karaoke is cleared.
      // DOM Range uses UTF-16 offsets, whereas the timeline counts Unicode characters.
      for (const span of [turn.before, turn.highlighted, turn.after]) {
        const text = span?.firstChild;
        if (!text?.textContent) continue;
        const characters = Array.from(text.textContent);
        if (remaining >= characters.length) {
          remaining -= characters.length;
          continue;
        }
        const offset = characters.slice(0, remaining).join("").length;
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + characters[remaining].length);
        bounds = range.getBoundingClientRect();
        break;
      }
      if (!bounds || bounds.height <= 0) return;
      // The two-column layout scrolls the transcript inside its own panel; follow there when it can scroll.
      if (followScrollContainer && followScrollContainer.scrollHeight > followScrollContainer.clientHeight) {
        const panel = followScrollContainer.getBoundingClientRect();
        const controls = transcriptDocument.previousElementSibling?.getBoundingClientRect();
        const panelTop = Math.max(panel.top, controls && controls.bottom <= panel.bottom ? controls.bottom : panel.top) + 12;
        const audioBar = media instanceof HTMLAudioElement
          ? root.querySelector("[data-meeting-player]")?.getBoundingClientRect()
          : null;
        const panelBottom = Math.min(panel.bottom, audioBar ? audioBar.top : panel.bottom) - 12;
        if (panelBottom <= panelTop) return;
        // Keep the reading line pinned near the upper third so the panel follows continuously.
        const offset = bounds.top - (panelTop + (panelBottom - panelTop) * 0.35);
        if (!force && Math.abs(offset) < 6) return;
        programmaticScrollUntil = performance.now() + 450;
        followScrollContainer.scrollBy({ top: offset, behavior: "smooth" });
        return;
      }
      let top = Math.max(16, document.querySelector("main > header")?.getBoundingClientRect().bottom || 0) + 16;
      const playerBounds = root.querySelector("[data-meeting-player]")?.getBoundingClientRect();
      const transcriptBounds = transcriptDocument.getBoundingClientRect();
      if (media instanceof HTMLVideoElement && playerBounds && playerBounds.left < transcriptBounds.right
        && playerBounds.right > transcriptBounds.left && playerBounds.bottom > top) {
        top = Math.min(window.innerHeight * 0.6, playerBounds.bottom + 16);
      }
      const bottom = media instanceof HTMLAudioElement && playerBounds
        ? Math.min(window.innerHeight - 64, playerBounds.top - 16) : window.innerHeight - 64;
      if (bottom <= top) return;
      const height = bottom - top;
      if (!force && bounds.top >= top + height * 0.15 && bounds.bottom <= top + height * 0.8) return;
      programmaticScrollUntil = performance.now() + 650;
      window.scrollBy({ top: bounds.top - (top + height * 0.4), behavior: "smooth" });
    }

    function showActiveWord() {
      const currentMs = media.currentTime * 1000;
      updateMediaControls();
      renderChapters(currentMs);
      const nextIndex = findActiveWord(currentMs);
      renderSubtitle(currentMs);
      if (nextIndex !== activeIndex) {
        const previousWord = activeIndex >= 0 ? words[activeIndex] : null;
        const nextWord = nextIndex >= 0 ? words[nextIndex] : null;
        if (previousWord && previousWord.turn !== nextWord?.turn) {
          previousWord.turn.element.removeAttribute("aria-current");
          resetKaraoke(previousWord.turn);
        }

        activeIndex = nextIndex;
        if (nextWord) {
          nextWord.turn.element.setAttribute("aria-current", "true");
        }
      }

      if (activeIndex >= 0) renderKaraoke(words[activeIndex], currentMs);
      if (!media.paused) followPlaybackPosition(currentMs);
    }

    function stopAnimation() {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }

    function animatePlayback() {
      showActiveWord();
      if (!media.paused && !media.ended) {
        setStatus(`再生中 ${formatTimestamp(media.currentTime)}`);
        animationFrame = requestAnimationFrame(animatePlayback);
      } else {
        animationFrame = null;
      }
    }

    function startAnimation() {
      stopAnimation();
      followPlaybackPosition(media.currentTime * 1000, true);
      animatePlayback();
    }

    function reportPlaybackError(error) {
      stopAnimation();
      const detail = error instanceof Error ? error.message : `${mediaLabel}を再生できませんでした`;
      setStatus(`再生エラー: ${detail}`);
    }

    function playFrom(seconds) {
      try {
        media.currentTime = seconds;
      } catch (error) {
        reportPlaybackError(error);
        return;
      }
      showActiveWord();
      const playback = media.play();
      if (playback) playback.catch(reportPlaybackError);
    }

    function seekAndPlay(milliseconds) {
      const seconds = milliseconds / 1000;
      if (!Number.isFinite(seconds) || seconds < 0) return;

      if (media.readyState === HTMLMediaElement.HAVE_NOTHING) {
        pendingSeekSeconds = seconds;
        setStatus(`${formatTimestamp(seconds)}を読み込み中`);
        media.load();
        return;
      }
      playFrom(seconds);
    }

    function togglePlayback() {
      if (media.paused || media.ended) {
        const playback = media.play();
        if (playback) playback.catch(reportPlaybackError);
      } else {
        media.pause();
      }
    }

    function skipPlayback(seconds) {
      if (!Number.isFinite(seconds)) return;
      const duration = Number.isFinite(media.duration)
        ? media.duration
        : Number.POSITIVE_INFINITY;
      try {
        media.currentTime = Math.min(duration, Math.max(0, media.currentTime + seconds));
      } catch (error) {
        reportPlaybackError(error);
        return;
      }
      showActiveWord();
    }

    function setPlaybackRate(rate) {
      if (!Number.isFinite(rate) || rate <= 0) return;
      media.playbackRate = rate;
      if (playbackRate instanceof HTMLSelectElement) {
        const matchingOption = Array.from(playbackRate.options).find(
          (option) => Math.abs(Number(option.value) - rate) < 0.001,
        );
        if (matchingOption) playbackRate.value = matchingOption.value;
        if (playbackRateValue) {
          playbackRateValue.textContent = matchingOption?.textContent || `${rate}×`;
        }
      }
    }

    function changePlaybackRate(direction) {
      if (!(playbackRate instanceof HTMLSelectElement) || direction === 0) return;
      const rates = Array.from(playbackRate.options)
        .map((option) => Number(option.value))
        .filter((rate) => Number.isFinite(rate) && rate > 0)
        .sort((left, right) => left - right);
      if (rates.length === 0) return;

      const currentRate = media.playbackRate;
      const nextRate = direction > 0
        ? rates.find((rate) => rate > currentRate + 0.001) ?? rates[rates.length - 1]
        : [...rates].reverse().find((rate) => rate < currentRate - 0.001) ?? rates[0];
      setPlaybackRate(nextRate);
    }

    function handlePlayerShortcut(event) {
      if (!root.isConnected) {
        document.removeEventListener("keydown", handlePlayerShortcut);
        clearVideoControlsTimer();
        return;
      }
      if (
        event.repeat
        || event.altKey
        || event.ctrlKey
        || event.metaKey
      ) {
        return;
      }
      const playbackRateDirection = event.shiftKey && event.code === "Period"
        ? 1
        : event.shiftKey && event.code === "Comma"
          ? -1
          : 0;
      if (
        playbackRateDirection === 0
        && ![
          "Space",
          "KeyC",
          "KeyF",
          "KeyJ",
          "KeyK",
          "KeyL",
          "KeyM",
          "ArrowLeft",
          "ArrowRight",
        ].includes(event.code)
      ) return;
      if (["KeyC", "KeyF"].includes(event.code) && !(media instanceof HTMLVideoElement)) {
        return;
      }
      if (!(event.target instanceof Element)) return;
      const editingTarget = event.target.closest(
        'input, textarea, select, a, summary, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
      );
      const focusedButton = event.target.closest('button, [role="button"]');
      const playerControlButton = focusedButton?.closest("[data-custom-media-controls]")
        && !focusedButton.closest("[data-player-settings]");
      if (
        editingTarget
        || (
          event.code === "Space"
          && focusedButton
          && !focusedButton.hasAttribute("data-chapter-segment")
          && !focusedButton.hasAttribute("data-seek-ms")
          && !playerControlButton
        )
        || document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        return;
      }
      event.preventDefault();
      if (
        focusedButton instanceof HTMLElement
        && (
          focusedButton.hasAttribute("data-chapter-segment")
          || focusedButton.hasAttribute("data-seek-ms")
          || (event.code === "Space" && playerControlButton)
        )
      ) {
        focusedButton.blur();
      }
      showVideoControls();
      if (playbackRateDirection !== 0) {
        changePlaybackRate(playbackRateDirection);
      } else if (event.code === "KeyC") {
        toggleSubtitles();
      } else if (event.code === "KeyF") {
        void toggleFullscreen();
      } else if (event.code === "KeyM") {
        toggleMute();
      } else if (event.code === "KeyJ") {
        skipPlayback(-10);
      } else if (event.code === "KeyL") {
        skipPlayback(10);
      } else if (event.code === "ArrowLeft") {
        skipPlayback(-5);
      } else if (event.code === "ArrowRight") {
        skipPlayback(5);
      } else {
        togglePlayback();
      }
    }

    function removeAutoFollowListeners() {
      document.removeEventListener("wheel", handleManualScrollIntent, true);
      document.removeEventListener("touchmove", handleManualScrollIntent, true);
      document.removeEventListener("keydown", handleManualScrollKey);
      window.removeEventListener("scroll", handleViewportScroll);
      followScrollContainer?.removeEventListener("scroll", handleViewportScroll);
    }

    function ensureFollowRootConnected() {
      if (root.isConnected) return true;
      removeAutoFollowListeners();
      transcriptVisibilityObserver?.disconnect();
      return false;
    }

    function handleManualScrollIntent() {
      if (!ensureFollowRootConnected()) return;
      pauseAutoFollow();
    }

    function handleManualScrollKey(event) {
      if (!ensureFollowRootConnected()) return;
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
        return;
      }
      if (
        event.target instanceof Element
        && event.target.closest(
          'input, textarea, select, button, a, summary, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="button"]',
        )
      ) {
        return;
      }
      pauseAutoFollow();
    }

    function handleViewportScroll() {
      if (!ensureFollowRootConnected()) return;
      const now = performance.now();
      if (now <= programmaticScrollUntil) {
        // Long smooth scrolls can exceed their initial grace period. Keep the
        // guard alive until scroll events settle; wheel/touch still pause immediately.
        programmaticScrollUntil = Math.max(programmaticScrollUntil, now + 200);
        return;
      }
      pauseAutoFollow();
    }

    function resumeAutoFollow() {
      autoFollowPaused = false;
      updateAutoFollowControl();
      lastFollowedCharacter = "";
      followPlaybackPosition(media.currentTime * 1000, true);
      showActiveWord();
    }


    function toggleMute() {
      if (media.volume === 0) media.volume = 1;
      media.muted = !media.muted;
      updateMediaControls();
    }

    async function toggleFullscreen() {
      if (!(mediaStage instanceof HTMLElement)) return;
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else if (mediaStage.requestFullscreen) {
          await mediaStage.requestFullscreen();
        } else if (typeof media.webkitEnterFullscreen === "function") {
          media.webkitEnterFullscreen();
        }
      } catch {
        setStatus("全画面表示を開始できませんでした");
      }
      updateMediaControls();
    }

    function seekTimeForClick(trigger, event) {
      const fallbackMs = Number(trigger.getAttribute("data-seek-ms"));
      if (!trigger.hasAttribute("data-transcript-text")) return fallbackMs;

      const turnIndex = Number(trigger.getAttribute("data-turn-index"));
      const turn = turns[turnIndex];
      if (!turn || turn.characters.length === 0) return fallbackMs;

      const index = characterIndexFromPoint(trigger, event.clientX, event.clientY);
      if (index === null) return fallbackMs;
      const characterIndex = Math.min(turn.characters.length - 1, Math.max(0, index));
      const word = findWordAtCharacter(turn, characterIndex);
      if (!word) return fallbackMs;

      const characterOffset = characterIndex - word.charStart;
      const characterLength = Math.max(1, word.charEnd - word.charStart);
      const progress = characterOffset / characterLength;
      return word.startMs + (word.endMs - word.startMs) * progress;
    }

    root.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;

      const chapterTrigger = event.target.closest("[data-chapter-segment]");
      if (chapterTrigger && root.contains(chapterTrigger)) {
        const chapter = chapters.find((item) => item.element === chapterTrigger);
        if (!chapter) return;
        layoutChapters();
        const bounds = chapterTrigger.getBoundingClientRect();
        const pointerProgress = bounds.width > 0
          ? Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
          : 0;
        const seekMs = event.detail === 0
          ? chapter.startMs
          : chapter.timelineStartMs
            + (chapter.timelineEndMs - chapter.timelineStartMs) * pointerProgress;
        event.preventDefault();
        seekAndPlay(seekMs);
        if (chapterTrigger instanceof HTMLElement) chapterTrigger.blur();
        return;
      }

      const trigger = event.target.closest("[data-seek-ms]");
      if (!trigger || !root.contains(trigger)) return;
      event.preventDefault();
      seekAndPlay(seekTimeForClick(trigger, event));
      if (trigger instanceof HTMLElement) trigger.blur();
    });

    document.addEventListener("wheel", handleManualScrollIntent, {
      passive: true,
      capture: true,
    });
    document.addEventListener("touchmove", handleManualScrollIntent, {
      passive: true,
      capture: true,
    });
    document.addEventListener("keydown", handleManualScrollKey);
    window.addEventListener("scroll", handleViewportScroll, { passive: true });
    followScrollContainer?.addEventListener("scroll", handleViewportScroll, { passive: true });
    window.addEventListener("speak-note:speaker-renamed", handleSpeakerRenamed);
    if (playToggle instanceof HTMLButtonElement) {
      playToggle.addEventListener("click", togglePlayback);
    }
    document.addEventListener("keydown", handlePlayerShortcut);
    if (volumeToggle instanceof HTMLButtonElement) {
      volumeToggle.addEventListener("click", toggleMute);
    }
    if (volumeSlider instanceof HTMLInputElement) {
      volumeSlider.addEventListener("input", () => {
        const volume = Math.min(1, Math.max(0, Number(volumeSlider.value)));
        if (!Number.isFinite(volume)) return;
        media.volume = volume;
        media.muted = volume === 0;
        updateMediaControls();
      });
    }
    if (fullscreenToggle instanceof HTMLButtonElement) {
      fullscreenToggle.addEventListener("click", () => void toggleFullscreen());
    }
    if (subtitleToggle instanceof HTMLButtonElement) {
      subtitleToggle.addEventListener("click", toggleSubtitles);
    }
    if (playbackRate instanceof HTMLSelectElement) {
      setPlaybackRate(media.playbackRate);
      playbackRate.addEventListener("change", () => {
        setPlaybackRate(Number(playbackRate.value));
      });
    }
    for (const skipButton of skipButtons) {
      if (!(skipButton instanceof HTMLButtonElement)) continue;
      skipButton.addEventListener("click", () => {
        const seconds = Number(skipButton.dataset.skipSeconds);
        skipPlayback(seconds);
      });
    }
    if (media instanceof HTMLVideoElement && customControls instanceof HTMLElement) {
      media.addEventListener("click", togglePlayback);
      media.addEventListener("dblclick", () => void toggleFullscreen());
      document.addEventListener("fullscreenchange", () => {
        updateMediaControls();
        showVideoControls();
      });
      if (mediaStage instanceof HTMLElement) {
        mediaStage.addEventListener("pointerenter", showVideoControls);
        mediaStage.addEventListener("pointermove", showVideoControls);
        mediaStage.addEventListener("pointerleave", hideVideoControls);
        showVideoControls();
      }
    }

    if (followResume instanceof HTMLButtonElement) {
      followResume.addEventListener("click", resumeAutoFollow);
    }
    updateAutoFollowControl();
    updateSubtitleControl();
    renderSubtitle(media.currentTime * 1000);

    function updateVideoAspect() {
      if (media instanceof HTMLVideoElement && mediaStage && media.videoWidth > 0 && media.videoHeight > 0) {
        mediaStage.style.setProperty("--video-aspect", String(media.videoWidth / media.videoHeight));
      }
    }
    media.addEventListener("resize", updateVideoAspect);
    updateVideoAspect();
    media.addEventListener("loadedmetadata", () => {
      updateVideoAspect();
      layoutChapters();
      renderChapters(media.currentTime * 1000);
      if (pendingSeekSeconds !== null) {
        const seconds = pendingSeekSeconds;
        pendingSeekSeconds = null;
        playFrom(seconds);
      } else {
        setStatus(readyMessage());
      }
    });
    media.addEventListener("timeupdate", showActiveWord);
    media.addEventListener("seeked", () => {
      showActiveWord();
      followPlaybackPosition(media.currentTime * 1000, true);
    });
    media.addEventListener("durationchange", updateMediaControls);
    media.addEventListener("volumechange", updateMediaControls);
    media.addEventListener("play", startAnimation);
    media.addEventListener("pause", () => {
      stopAnimation();
      showActiveWord();
      if (!media.ended) setStatus(`一時停止 ${formatTimestamp(media.currentTime)}`);
    });
    media.addEventListener("ended", () => {
      stopAnimation();
      showActiveWord();
      setStatus("再生が終了しました");
    });
    media.addEventListener("error", () => {
      reportPlaybackError(new Error(media.error?.message || `${mediaLabel}を読み込めませんでした`));
    });

    layoutChapters();
    renderChapters(media.currentTime * 1000);
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
      setStatus(readyMessage());
      showActiveWord();
    } else {
      setStatus(`${mediaLabel}を読み込み中`);
    }
  }

  function initializeAllPlayers() {
    document.querySelectorAll("[data-transcript-player]").forEach(initializePlayer);
  }

  if (!window.speakNoteTranscriptPlayer) {
    window.speakNoteTranscriptPlayer = { initialize: initializeAllPlayers };
    const observer = new MutationObserver(initializeAllPlayers);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAllPlayers, { once: true });
  } else {
    initializeAllPlayers();
  }
})();
