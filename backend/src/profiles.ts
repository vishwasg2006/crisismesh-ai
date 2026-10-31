import { Hazard } from './types';

/**
 * Hazard profiles. Flood is fully modelled (water level / rise rate / boats).
 * Fire and landslide reuse the same pipeline with different scoring weights + keywords
 * (the "hazard level" fields on settlements are interpreted generically).
 */
export const PROFILES: Record<
  Hazard,
  {
    label: string;
    weights: { danger: number; people: number; access: number; time: number };
    keywords: Record<string, string[]>;
  }
> = {
  flood: {
    label: 'Flood',
    weights: { danger: 0.3, people: 0.25, access: 0.15, time: 0.3 },
    keywords: {},
  },
  fire: {
    label: 'Fire',
    weights: { danger: 0.35, people: 0.25, access: 0.1, time: 0.3 },
    keywords: { fire: ['fire', 'flames', 'burning'], smoke: ['smoke', 'suffocat'], explosion: ['explosion', 'cylinder blast'] },
  },
  landslide: {
    label: 'Landslide',
    weights: { danger: 0.3, people: 0.2, access: 0.25, time: 0.25 },
    keywords: { landslide: ['landslide', 'mudslide', 'slope collapse'], buried: ['buried', 'under debris', 'under mud'] },
  },
};
