import type { ModeDefinition } from './Mode';
import { LuminousHall } from './luminousHall/LuminousHall';
import { InkCurrent } from './ink/InkCurrent';
import { Garden } from './garden/Garden';
import { Celestial } from './celestial/Celestial';

export const modeRegistry: ModeDefinition[] = [
  {
    id: 'luminous-hall',
    name: 'The Luminous Hall',
    description:
      'Stand at the podium of a dark concert hall where every voice is a strand of living light.',
    available: true,
    create: () => new LuminousHall(),
  },
  {
    id: 'ink-and-current',
    name: 'Ink and Current',
    description: 'Voices as pigment currents in water; counterpoint braids, swells flood the sheet.',
    available: true,
    create: () => new InkCurrent(),
  },
  {
    id: 'growing-garden',
    name: 'The Growing Garden',
    description: 'Phrases grow living forms on parchment; the finished piece is a grown landscape.',
    available: true,
    create: () => new Garden(),
  },
  {
    id: 'celestial-mechanics',
    name: 'Celestial Mechanics',
    description: 'Voices orbit the night sky with trails; harmony aligns them, dissonance scatters.',
    available: true,
    create: () => new Celestial(),
  },
];

export function getMode(id: string): ModeDefinition | undefined {
  return modeRegistry.find((m) => m.id === id);
}
