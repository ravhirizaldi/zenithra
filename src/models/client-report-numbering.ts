import { children, must, optionalField, type XmlNode } from './client-definition-xml.js';

// AutoNumbering.ClusterIs: this is a KeyboardText option, not the separate AutoNumbering cluster pipeline.
export const reportNumberingClusters = (top: XmlNode) =>
  children(must(top, 'sheets'), 'sheet').flatMap((sheet) =>
    children(must(sheet, 'clusters'), 'cluster')
      .filter(
        (cluster) =>
          optionalField(cluster, 'type') === 'KeyboardText' &&
          optionalField(cluster, 'inputParameters')
            .split(';')
            .map((part) => part.split('='))
            .find((part) => part[0] === 'AutoNumber')?.[1] === '1',
      )
      .map((cluster) => ({ sheet, cluster })),
  );
