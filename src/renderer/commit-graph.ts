import type { GitCommit } from '../repository/types.js'

export const layoutCommits = (commits: GitCommit[]) => {
  const displayed = commits.slice(0, 100)
  const observedHashes = new Set(displayed.map(commit => commit.hash))
  const lanes: Array<string | null> = []
  const nodes = displayed.map((commit, row) => {
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
    }
    lanes[lane] = null
    const observedParents = [...new Set(commit.parentHashes)].filter(parent => observedHashes.has(parent))
    observedParents.forEach((parent, index) => {
      if (lanes.includes(parent)) return
      const empty = index === 0 && lanes[lane] === null ? lane : lanes.indexOf(null)
      lanes[empty < 0 ? lanes.length : empty] = parent
    })
    return { commit, row, lane }
  })
  const byHash = new Map(nodes.map(node => [node.commit.hash, node]))
  const edges: Array<{ from: typeof nodes[number]; to: typeof nodes[number] | null; parent: string }> = []
  const totalEdges = nodes.reduce((total, node) => total + node.commit.parentHashes.length, 0)
  nodes.forEach(node => {
    node.commit.parentHashes.slice(0, 2000 - edges.length).forEach(parent => {
      edges.push({ from: node, to: byHash.get(parent) ?? null, parent })
    })
  })
  return {
    nodes, edges, edgesOmitted: totalEdges - edges.length, commitsOmitted: commits.length - displayed.length,
    laneCount: Math.max(1, ...nodes.map(node => node.lane + 1)),
  }
}
