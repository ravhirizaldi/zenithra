import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseDeleteDays,
  voiceGrammarFromPost,
  voiceGrammarFromRows,
} from '../../../../src/controllers/manager/system/maintenance.js';

test('custom master retention validation keeps legacy defaults and range', () => {
  assert.deepEqual(parseDeleteDays(undefined), { days: 365, error: '' });
  assert.deepEqual(parseDeleteDays('999'), { days: 999, error: '' });
  assert.match(parseDeleteDays('0').error, /between 1 and 999/);
  assert.match(parseDeleteDays('1000').error, /between 1 and 999/);
  assert.match(parseDeleteDays('1.5').error, /not valid for DeleteDays/);
});

test('voice grammar loading preserves key order, defaults, and legacy comma conversion', () => {
  const grammars = voiceGrammarFromRows([
    { common_key: 'ok', voice_value: 'おっけー、はい', anwser_back: 'OK', anwser_back_option: '1' },
    { common_key: 'unrecognized', voice_value: 'ignored', anwser_back: 'ignored', anwser_back_option: '1' },
  ]);
  assert.deepEqual(
    grammars.map((grammar) => grammar.CommonKey),
    ['retry', 'ok', 'cancel', 'undo', 'redo'],
  );
  assert.equal(grammars[0].VoiceValue, null);
  assert.equal(grammars[1].VoiceValue, 'おっけー,はい');
  assert.equal(grammars[1].AnswerBack, 'OK');
  assert.equal(grammars[1].IsAnsverBackCluster, true);
});

test('voice grammar form binding converts full-width commas and repeated checkbox values', () => {
  const grammars = voiceGrammarFromPost({
    'VoiceCommonList.CommonGrammarList[0].CommonKey': 'retry',
    'VoiceCommonList.CommonGrammarList[0].VoiceValue': 'へんしゅう、編集',
    'VoiceCommonList.CommonGrammarList[0].AnswerBack': '編集',
    'VoiceCommonList.CommonGrammarList[0].IsAnsverBackCluster': ['true', 'false'],
  });
  assert.deepEqual(grammars, [
    {
      CommonKey: 'retry',
      CommonName: 'Turn focused cluster to editing status',
      VoiceValue: 'へんしゅう,編集',
      AnswerBack: '編集',
      IsAnsverBackCluster: true,
    },
  ]);
});
