import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const base = '/ConMasManager';
export const menus = [
  ['Forms', 'DefReport'],
  ['Documents', 'InputReport'],
  ['Data Output', 'DataOutput'],
  ['Doc. Import', 'AutoGenerate'],
  ['Labels', 'Label'],
  ['Library', 'Library?mode=ComLIb'],
  ['Schedule', 'Schedule/CalendarView'],
  ['Master Manager', 'CustomMaster?mode=ComMas'],
  ['Custom menu', 'CustomMenu'],
  ['Binder', 'Binder'],
  ['System', 'System'],
] as const;
