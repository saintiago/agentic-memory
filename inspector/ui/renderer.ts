/**
 * The Sigma v3 rendering adapter: it owns the WebGL view, the camera and the reducers that apply
 * the dashboard's styling rules to the existing Graphology graph. Everything else the dashboard
 * does stays independent of Sigma, so a later renderer replacement keeps the data and projection
 * contracts unchanged.
 *
 * See docs/dashboard.md#tools-and-ownership, docs/dashboard.md#visual-behavior and
 * docs/dashboard.md#live-updates-with-sigma.
 */
import type { DirectedGraph } from "graphology";
import Sigma from "sigma";

import type { GraphBounds } from "../payloads.js";
import {
  linkStyle,
  nodeStyle,
  type LinkAttributes,
  type NodeAttributes,
  type StyleSource,
} from "./style.js";

/** The camera state the dashboard reads for diagnostics and preservation checks. */
export interface CameraSnapshot {
  readonly x: number;
  readonly y: number;
  readonly ratio: number;
}

/** The rendering operations the dashboard needs; Sigma is one implementation. */
export interface DashboardRenderer {
  /** Re-apply the display rules after the selection, results or freshness time changed. */
  styleChanged(): void;
  /** Union the supplied extent into the normalization box without moving the camera. */
  includeBounds(bounds: GraphBounds): void;
  fitAll(): void;
  fitNodes(nodeIds: readonly string[]): void;
  focus(nodeId: string): void;
  cameraState(): CameraSnapshot;
  viewportPosition(
    nodeId: string,
  ): { readonly x: number; readonly y: number } | undefined;
  dispose(): void;
}

/** The drawn span of one node set; a single point keeps a small non-empty span. */
const boundsOfPoints = (
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): GraphBounds | undefined => {
  const first = points[0];
  if (first === undefined) {
    return undefined;
  }
  let minX = first.x;
  let maxX = first.x;
  let minY = first.y;
  let maxY = first.y;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { x: [minX, maxX], y: [minY, maxY] };
};

const centerOf = (bounds: GraphBounds): { x: number; y: number } => ({
  x: (bounds.x[0] + bounds.x[1]) / 2,
  y: (bounds.y[0] + bounds.y[1]) / 2,
});

const spanOf = (bounds: GraphBounds): number =>
  Math.max(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]) || 1;

const unionOf = (left: GraphBounds, right: GraphBounds): GraphBounds => ({
  x: [Math.min(left.x[0], right.x[0]), Math.max(left.x[1], right.x[1])],
  y: [Math.min(left.y[0], right.y[0]), Math.max(left.y[1], right.y[1])],
});

/** The extent Sigma derives its aspect-dependent correction ratio from. */
const extentOf = (
  bounds: GraphBounds,
): { readonly width: number; readonly height: number } => ({
  width: bounds.x[1] - bounds.x[0] || 1,
  height: bounds.y[1] - bounds.y[0] || 1,
});

const sameBounds = (left: GraphBounds, right: GraphBounds): boolean =>
  left.x[0] === right.x[0] &&
  left.x[1] === right.x[1] &&
  left.y[0] === right.y[0] &&
  left.y[1] === right.y[1];

/** The Sigma coordinate of one graph point inside the normalization box. */
const framedPoint = (
  bounds: GraphBounds,
  point: { readonly x: number; readonly y: number },
): { x: number; y: number } => {
  const center = centerOf(bounds);
  const span = spanOf(bounds);
  return {
    x: 0.5 + (point.x - center.x) / span,
    y: 0.5 + (point.y - center.y) / span,
  };
};

export interface SigmaRendererOptions {
  readonly container: HTMLElement;
  readonly graph: DirectedGraph<NodeAttributes, LinkAttributes>;
  readonly style: StyleSource;
  readonly onSelect: (nodeId: string | undefined) => void;
}

/** Create the Sigma view over one displayed graph. */
export const createSigmaRenderer = (
  options: SigmaRendererOptions,
): DashboardRenderer => {
  const { container, graph, style, onSelect } = options;
  const sigma = new Sigma(graph, container, {
    renderLabels: true,
    renderEdgeLabels: false,
    // The link layer is the expensive one at inspection scale; skipping it while the user moves
    // the camera keeps zoom and pan responsive on a large plain-link graph.
    hideEdgesOnMove: true,
    defaultEdgeType: "arrow",
    labelDensity: 0.5,
    labelGridCellSize: 140,
    labelRenderedSizeThreshold: 8,
    labelSize: 12,
    stagePadding: 24,
    zIndex: true,
    minCameraRatio: 1e-6,
    maxCameraRatio: 1e6,
    // Sigma applies its defaults to the reducer result, so it must keep the stored evidence it
    // does not restyle: the node position above all.
    nodeReducer: (node, data) => ({ ...data, ...nodeStyle(style, node, data) }),
    edgeReducer: (edge, data) => {
      const [source, target] = graph.extremities(edge);
      return { ...data, ...linkStyle(style, { source, target }) };
    },
  });

  sigma.on("clickNode", ({ node }) => {
    onSelect(node);
  });
  sigma.on("clickStage", () => {
    onSelect(undefined);
  });

  let customBBox: GraphBounds | undefined;

  const dimensions = (): { readonly width: number; readonly height: number } =>
    sigma.getDimensions();

  /** The normalization span of the box Sigma currently frames the graph with. */
  const normalizationSpan = (): number => spanOf(customBBox ?? sigma.getBBox());

  /** The displayed box, which is what Sigma normalizes and derives its correction ratio from. */
  const normalizationBounds = (): GraphBounds => customBBox ?? sigma.getBBox();

  /**
   * Pixels one framed-graph unit covers on screen for the supplied extent, measured through
   * Sigma's own conversion so the camera ratio, the viewport and Sigma's aspect-dependent
   * correction ratio are all accounted for without duplicating them here.
   */
  const pixelsPerFramedUnit = (bounds: GraphBounds): number => {
    const graphDimensions = extentOf(bounds);
    const origin = sigma.framedGraphToViewport(
      { x: 0, y: 0 },
      { graphDimensions },
    );
    const unit = sigma.framedGraphToViewport(
      { x: 1, y: 0 },
      { graphDimensions },
    );
    return Math.abs(unit.x - origin.x) || 1;
  };

  /** Pixels one graph unit covers on screen at the current camera and normalization box. */
  const pixelsPerGraphUnit = (): number =>
    pixelsPerFramedUnit(normalizationBounds()) / normalizationSpan();

  /**
   * Move the camera so the supplied graph point sits at the viewport center. The camera position
   * is a framed-graph coordinate, so the required move is the graph-space difference divided by
   * the normalization span; measuring the point at the viewport center stays a live conversion.
   */
  const centerOn = (point: {
    readonly x: number;
    readonly y: number;
  }): void => {
    const { width, height } = dimensions();
    const camera = sigma.getCamera();
    const state = camera.getState();
    const atCentre = sigma.viewportToGraph({ x: width / 2, y: height / 2 });
    const span = normalizationSpan();
    camera.setState({
      x: state.x + (point.x - atCentre.x) / span,
      y: state.y + (point.y - atCentre.y) / span,
    });
  };

  /** Fit one graph extent into the viewport without changing the normalization box. */
  const fitToBounds = (bounds: GraphBounds): void => {
    const { width, height } = dimensions();
    const padding = 40;
    const available = {
      width: Math.max(1, width - 2 * padding),
      height: Math.max(1, height - 2 * padding),
    };
    const camera = sigma.getCamera();
    const state = camera.getState();
    const pixels = pixelsPerGraphUnit();
    const spanX = bounds.x[1] - bounds.x[0];
    const spanY = bounds.y[1] - bounds.y[0];
    const ratios: number[] = [];
    if (spanX > 0) {
      ratios.push((state.ratio * pixels) / (available.width / spanX));
    }
    if (spanY > 0) {
      ratios.push((state.ratio * pixels) / (available.height / spanY));
    }
    if (ratios.length > 0) {
      camera.setState({
        ratio: camera.getBoundedRatio(Math.max(...ratios)),
      });
    }
    centerOn(centerOf(bounds));
  };

  return {
    styleChanged: (): void => {
      sigma.scheduleRefresh();
    },
    includeBounds: (bounds: GraphBounds): void => {
      const current = customBBox;
      if (current === undefined) {
        customBBox = bounds;
        sigma.setCustomBBox(customBBox);
        return;
      }
      const next = unionOf(current, bounds);
      if (sameBounds(current, next)) {
        return;
      }
      // Keep the graph point at the viewport center centered and the pixel scale unchanged. The
      // displayed scale depends on the normalization span, on the camera ratio and on Sigma's
      // aspect-dependent correction ratio, which changes when an asymmetric extent changes the
      // box ratio; both boxes are therefore measured through Sigma's own framed-graph conversion
      // instead of compensating the span alone.
      const { width, height } = dimensions();
      const reference = sigma.viewportToGraph({ x: width / 2, y: height / 2 });
      const camera = sigma.getCamera();
      const state = camera.getState();
      const before = pixelsPerFramedUnit(current);
      const after = pixelsPerFramedUnit(next);
      const framed = framedPoint(next, reference);
      customBBox = next;
      sigma.setCustomBBox(customBBox);
      camera.setState({
        x: framed.x,
        y: framed.y,
        ratio: camera.getBoundedRatio(
          (state.ratio * (spanOf(current) / spanOf(next)) * after) / before,
        ),
      });
    },
    fitAll: (): void => {
      fitToBounds(customBBox ?? sigma.getBBox());
    },
    fitNodes: (nodeIds: readonly string[]): void => {
      const points = nodeIds
        .filter((nodeId) => graph.hasNode(nodeId))
        .map((nodeId) => graph.getNodeAttributes(nodeId));
      const bounds = boundsOfPoints(points);
      if (bounds !== undefined) {
        fitToBounds(bounds);
      }
    },
    focus: (nodeId: string): void => {
      if (!graph.hasNode(nodeId)) {
        return;
      }
      const attributes = graph.getNodeAttributes(nodeId);
      const camera = sigma.getCamera();
      const state = camera.getState();
      camera.setState({ ratio: camera.getBoundedRatio(state.ratio * 0.5) });
      centerOn({ x: attributes.x, y: attributes.y });
    },
    cameraState: (): CameraSnapshot => {
      const state = sigma.getCamera().getState();
      return { x: state.x, y: state.y, ratio: state.ratio };
    },
    viewportPosition: (
      nodeId: string,
    ): { readonly x: number; readonly y: number } | undefined => {
      if (!graph.hasNode(nodeId)) {
        return undefined;
      }
      const attributes = graph.getNodeAttributes(nodeId);
      return sigma.graphToViewport({ x: attributes.x, y: attributes.y });
    },
    dispose: (): void => {
      sigma.kill();
    },
  };
};
