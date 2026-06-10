import type { ModeDefinition } from './Mode';
import { LuminousHall } from './luminousHall/LuminousHall';

export const modeRegistry: ModeDefinition[] = [
  {
    id: 'luminous-hall',
    name: 'The Luminous Hall',
    description:
      'Stand at the podium of a dark concert hall where every voice is a body of living light.',
    available: true,
    create: () => new LuminousHall(),
  },
  {
    id: 'ink-and-current',
    name: 'Ink and Current',
    description: 'Voices as pigment streams in fluid; counterpoint braids, tutti merges.',
    available: false,
  },
  {
    id: 'growing-garden',
    name: 'Growing Garden',
    description: 'Phrases grow persistent botanical forms; the finished piece is a landscape.',
    available: false,
  },
  {
    id: 'celestial-mechanics',
    name: 'Celestial Mechanics',
    description: 'Voices as orbiting light bodies; harmony pulls orbits into alignment.',
    available: false,
  },
];

export function getMode(id: string): ModeDefinition | undefined {
  return modeRegistry.find((m) => m.id === id);
}
