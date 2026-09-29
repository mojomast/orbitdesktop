import {calculateDiff} from './candidate-diff-engine';
import type {CandidateDiffFile} from './candidate-diff-types';

self.onmessage = (event: MessageEvent<{id: number | string; file: CandidateDiffFile; ignoreWhitespace?: boolean}>) => {
  const {id, file, ignoreWhitespace} = event.data;
  try {
    self.postMessage({id, result: calculateDiff(file, {ignoreWhitespace})});
  } catch (error) {
    self.postMessage({id, error: error instanceof Error ? error.message : String(error)});
  }
};
