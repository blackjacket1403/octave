import * as THREE from 'three';

/** Concert-hall light: warm golds and ivories, one cool silver voice. Never neon. */
export const BAND_COLORS = [
  new THREE.Color('#a86a24'), // bass — deep amber
  new THREE.Color('#cf9a45'), // tenor — warm gold
  new THREE.Color('#e6c378'), // alto — candle gold
  new THREE.Color('#f1e6c8'), // soprano — ivory
  new THREE.Color('#aec6e2'), // brilliance — silver-blue
];

/** What non-salient bodies desaturate toward. */
export const DIM_COLOR = new THREE.Color('#56586a');

/** Register seating: base altitude per band (bass low, brilliance overhead). */
export const BAND_HEIGHT = [1.3, 3.0, 4.8, 6.8, 9.0];

/**
 * Default "orchestra seating" pan per band, used when a band is too quiet
 * for its measured pan to mean anything (violins house-left, basses right).
 */
export const BAND_HOME_PAN = [0.5, 0.28, -0.05, -0.38, 0.12];

export const HAZE_COOL = new THREE.Color('#171a2c');
export const HAZE_WARM = new THREE.Color('#2c2114');
export const SKY_BOTTOM = new THREE.Color('#06070c');
export const SKY_HORIZON_COOL = new THREE.Color('#10121f');
export const SKY_HORIZON_WARM = new THREE.Color('#1c150e');
export const SKY_TOP = new THREE.Color('#020207');
export const AFTERGLOW_COLOR = new THREE.Color('#caa050');
