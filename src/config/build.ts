declare const __CONMAS_MINIFY__: boolean;

export const productionBuild = typeof __CONMAS_MINIFY__ !== 'undefined' && __CONMAS_MINIFY__;
