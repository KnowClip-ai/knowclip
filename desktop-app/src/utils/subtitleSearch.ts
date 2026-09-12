import type { Sentence } from '../types';

export function locateTextInSubtitles(
  clipContent: string,
  fullText: string,
  sentences: Sentence[]
): { startMs: number; endMs: number; matchedText: string; confidence: number } | null {
  if (!clipContent || !fullText || sentences.length === 0) return null;

  const clean = (s: string) => s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const cleanClip = clean(clipContent);
  const cleanFull = clean(fullText);
  if (cleanClip.length === 0) return null;

  const calcHamming = (s1: string, s2: string): number => {
    if (s1.length !== s2.length) return Infinity;
    let diff = 0;
    for (let i = 0; i < s1.length; i++) {
      if (s1[i] !== s2[i]) diff++;
    }
    return diff;
  };

  const isWithinTolerance = (s1: string, s2: string, maxDist: number): boolean => {
    if (s1.length !== s2.length) return false;
    return calcHamming(s1, s2) <= maxDist;
  };

  const searchCandidates = (
    anchorLen: number,
    maxDist: number
  ): Array<{ startCleanIdx: number; endCleanIdx: number; confidence: number }> => {
    const actualLen = Math.min(anchorLen, cleanClip.length);
    const prefix = cleanClip.slice(0, actualLen);
    const suffix = cleanClip.slice(-actualLen);
    const clipLen = cleanClip.length;
    const result: Array<{ startCleanIdx: number; endCleanIdx: number; confidence: number }> = [];
    for (let i = 0; i <= cleanFull.length - clipLen; i++) {
      const windowPrefix = cleanFull.slice(i, i + actualLen);
      if (!isWithinTolerance(windowPrefix, prefix, maxDist)) continue;
      const prefixDist = calcHamming(windowPrefix, prefix);
      const suffixStart = i + clipLen - actualLen;
      const searchStart = Math.max(0, suffixStart - 15);
      const searchEnd = Math.min(cleanFull.length - actualLen, suffixStart + 15);
      if (searchStart > searchEnd) continue;
      for (let j = searchStart; j <= searchEnd; j++) {
        const windowSuffix = cleanFull.slice(j, j + actualLen);
        if (!isWithinTolerance(windowSuffix, suffix, maxDist)) continue;
        const suffixDist = calcHamming(windowSuffix, suffix);
        const matchedLen = (j + actualLen) - i;
        if (matchedLen !== clipLen) continue;
        const totalAnchorLen = actualLen * 2;
        const confidence = totalAnchorLen > 0
          ? 1 - (prefixDist + suffixDist) / (totalAnchorLen * 0.5)
          : 1;
        result.push({
          startCleanIdx: i,
          endCleanIdx: j + actualLen,
          confidence: Math.max(0, Math.min(1, confidence))
        });
      }
    }
    return result;
  };

  let candidates = searchCandidates(15, 0);
  if (candidates.length === 0) {
    candidates = searchCandidates(15, 2);
  }
  if (candidates.length === 0) return null;

  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter(c => {
    const key = `${c.startCleanIdx}-${c.endCleanIdx}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let best = uniqueCandidates[0];
  if (uniqueCandidates.length > 1) {
    best = uniqueCandidates.reduce((prev, curr) =>
      curr.confidence > prev.confidence ? curr : prev
    );
  }

  const { startCleanIdx, endCleanIdx, confidence } = best;

  const isPunctuation = (char: string): boolean =>
    /[，。！？、；："'（）【】《》…—～｜,.!?;:"'()\[\]{}]/.test(char);

  let cleanCharCount = 0;
  let startMs = 0;
  let endMs = 0;
  let foundStart = false;
  let foundEnd = false;
  let startSentIdx = -1, startWordIdx = -1;
  let endSentIdx = -1, endWordIdx = -1;

  outerLoop:
  for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
    const sent = sentences[sIdx];
    for (let wIdx = 0; wIdx < sent.words.length; wIdx++) {
      const word = sent.words[wIdx];
      const wordClean = clean(word.word);
      const wordCleanLen = wordClean.length;
      if (!foundStart && cleanCharCount + wordCleanLen > startCleanIdx) {
        startMs = word.start_ms;
        startSentIdx = sIdx;
        startWordIdx = wIdx;
        foundStart = true;
      }
      if (foundStart && !foundEnd && cleanCharCount + wordCleanLen >= endCleanIdx) {
        endMs = word.end_ms;
        endSentIdx = sIdx;
        endWordIdx = wIdx;
        if (wIdx + 1 < sent.words.length) {
          const nextWord = sent.words[wIdx + 1];
          if (isPunctuation(nextWord.word)) {
            endMs = nextWord.end_ms;
            endWordIdx = wIdx + 1;
          }
        }
        foundEnd = true;
        break outerLoop;
      }
      cleanCharCount += wordCleanLen;
    }
  }

  if (!foundStart) return null;
  if (!foundEnd) {
    endMs = sentences[sentences.length - 1]?.end || startMs + 5000;
    endSentIdx = sentences.length - 1;
    endWordIdx = sentences[endSentIdx]?.words.length - 1 || 0;
  }

  const matchedTextParts: string[] = [];
  for (let s = startSentIdx; s <= endSentIdx; s++) {
    const sent = sentences[s];
    const wStart = (s === startSentIdx) ? startWordIdx : 0;
    const wEnd = (s === endSentIdx) ? endWordIdx : sent.words.length - 1;
    for (let w = wStart; w <= wEnd; w++) {
      matchedTextParts.push(sent.words[w].word);
    }
  }

  const matchedText = matchedTextParts.join('');
  return { startMs, endMs, matchedText, confidence };
}
