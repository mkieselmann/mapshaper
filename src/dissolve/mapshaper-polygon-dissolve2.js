import { reversePath } from '../paths/mapshaper-path-utils';
import { getRingIntersector } from '../paths/mapshaper-pathfinder';
import { getSliverFilter } from '../polygons/mapshaper-slivers';
import { getArcPresenceTest } from '../paths/mapshaper-path-utils';
import { composeDissolveLayer } from '../commands/mapshaper-dissolve';
import { getCategoryClassifier } from '../dissolve/mapshaper-data-aggregation';
import { DataTable } from '../datatable/mapshaper-data-table';
import { NodeCollection } from '../topology/mapshaper-nodes';
import { MosaicIndex } from '../polygons/mapshaper-mosaic-index';
import utils from '../utils/mapshaper-utils';
import { message } from '../utils/mapshaper-logging';
import { compileValueExpression } from '../expressions/mapshaper-expressions';

// Assumes that arcs do not intersect except at endpoints
export function dissolvePolygonLayer2(lyr, dataset, opts) {
  opts = utils.extend({}, opts);
  if (opts.field) {
    opts.fields = [opts.field]; // support old "field" parameter
  }
  var getGroupId = getCategoryClassifier(opts.fields, lyr.data);
  var groups = groupPolygons2(lyr, getGroupId);
  var shapes2 = dissolvePolygonGroups2(groups, lyr, dataset, opts);
  return composeDissolveLayer(lyr, shapes2, getGroupId, opts);
}

function getArcLayer(arcs, name) {
  var records = [];
  var lyr = {
    geometry_type: 'polyline',
    shapes: [],
    name: name
  };
  for (var i=0, n=arcs.size(); i<n; i++) {
    lyr.shapes.push([[i]]);
    records.push({arc_id: i});
  }
  lyr.data = new DataTable(records);
  return lyr;
}

export function composeMosaicLayer(lyr, shapes2) {
  var records = shapes2.map(function(shp, i) {
    return {tile_id: i};
  });
  return utils.defaults({
    shapes: shapes2,
    data: new DataTable(records)
  }, lyr);
}

function groupPolygons2(lyr, getGroupId) {
  return lyr.shapes.reduce(function(groups, shape, shapeId) {
    var groupId = getGroupId(shapeId);
    if (groupId in groups === false) {
      groups[groupId] = [];
    }
    groups[groupId].push(shapeId);
    return groups;
  }, []);
}

function getGapRemovalMessage(removed, retained, areaLabel, adjacentShapesLabel) {
  var msg;
  if (removed > 0 === false) return '';
  return utils.format('Closed %,d / %,d gap%s using %s. %s',
      removed, removed + retained, utils.pluralSuffix(removed), areaLabel, adjacentShapesLabel);
}

export function dissolvePolygonGroups2(groups, lyr, dataset, opts) {
  var arcFilter = getArcPresenceTest(lyr.shapes, dataset.arcs);
  var nodes = new NodeCollection(dataset.arcs, arcFilter);
  var mosaicOpts = {
    flat: true,
    simple: groups.length == 1
  };
  var mosaicIndex = new MosaicIndex(lyr, nodes, mosaicOpts);
  var sliverOpts = utils.extend({sliver_control: 1}, opts);
  var filterData = getSliverFilter(lyr, dataset, sliverOpts);
  var adjacentShapesFilter = getAdjacentShapesFilter(lyr, dataset, opts);
  var cleanupData = mosaicIndex.removeGaps(filterData.filter, adjacentShapesFilter.filter);
  var pathfind = getRingIntersector(mosaicIndex.nodes);
  var dissolvedShapes = groups.map(function(shapeIds) {
    var tiles = mosaicIndex.getTilesByShapeIds(shapeIds);
    if (opts.tiles) {
      return tiles.reduce(function(memo, tile) {
        return memo.concat(tile);
      }, []);
    }
    return dissolveTileGroup2(tiles, pathfind);
  });
  // convert self-intersecting rings to outer/inner rings, for OGC
  // Simple Features compliance
  dissolvedShapes = fixTangentHoles(dissolvedShapes, pathfind);
  var gapMessage = getGapRemovalMessage(cleanupData.removed, cleanupData.remaining, filterData.label, adjacentShapesFilter.label);
  if (gapMessage) message(gapMessage);
  return dissolvedShapes;
}

function getAdjacentShapesFilter(lyr, dataset, opts) {
  var filter, label;
  if (opts.merge_gaps_where) {
    var filterFunc = compileValueExpression(opts.merge_gaps_where, lyr, dataset.arcs);
    filter = function(shapeId) {
      var result = filterFunc(shapeId)
      return !result
    }
    label = "Assigned gaps where: " + opts.merge_gaps_where
  } else {
    filter = function(shapeId) { return false }
    label = ""
  }
  return {
    filter: filter,
    label: label
  };
}

function dissolveTileGroup2(tiles, pathfind) {
  var rings = [],
      holes = [],
      dissolved, tile;
  for (var i=0, n=tiles.length; i<n; i++) {
    tile = tiles[i];
    rings.push(tile[0]);
    if (tile.length > 1) {
      holes = holes.concat(tile.slice(1));
    }
  }
  dissolved = pathfind(rings.concat(holes), 'dissolve');
  if (dissolved.length > 1) {
    // Commenting-out nesting order repair -- new method should prevent nesting errors
    // dissolved = internal.fixNestingErrors(dissolved, arcs);
  }
  return dissolved.length > 0 ? dissolved : null;
}

function fixTangentHoles(shapes, pathfind) {
  var onRing = function(memo, ring) {
    reversePath(ring);
    var fixed = pathfind([ring], 'flatten');
    if (fixed.length > 1) {
      fixed.forEach(reversePath);
      memo = memo.concat(fixed);
    } else {
      memo.push(reversePath(ring));
    }
    return memo;
  };
  return shapes.map(function(rings) {
    if (!rings) return null;
    return rings.reduce(onRing, []);
  });
}
