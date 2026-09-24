export interface SemanticNode {
  id: string;
  tag: string;
  role: string;
  text: string;
  name: string;
  semanticRole?: string;
  href?: string;
  interactive: boolean;
  disabled: boolean;
  checked?: boolean;
  expanded?: boolean;
  value?: string;
  visibility: 'visible' | 'unknown';
  geometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  aria: Record<string, string>;
  parentId?: string;
  children: string[];
  context: string;
  entity?: string;
  documentURL?: string;
  framePath?: string[];
  locator: {
    css: string;
    testId?: string;
    htmlId?: string;
  };
}
export interface SemanticDocument {
  version: 1;
  url: string;
  title: string;
  capturedAt: string;
  source: 'http' | 'browser';
  nodes: SemanticNode[];
  accessibility?: string;
  warnings?: string[];
}
