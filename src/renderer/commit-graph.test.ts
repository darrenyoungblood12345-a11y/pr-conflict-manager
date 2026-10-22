import { expect, it } from 'vitest'
import { layoutCommits } from './commit-graph.js'

it('preserves both merge parents, distinct lanes, and truncated ancestry', () => {
  const commits = [
    ['merge', ['left', 'right']], ['left', ['base']], ['right', ['base']], ['base', ['outside']],
  ].map(([hash, parentHashes]) => ({ hash: hash as string, parentHashes: parentHashes as string[], subject: '', timestamp: '' }))
  const graph = layoutCommits(commits)
  expect(graph.edges.filter(edge => edge.from.commit.hash === 'merge').map(edge => edge.to?.commit.hash)).toEqual(['left', 'right'])
  expect(graph.nodes[1].lane).not.toBe(graph.nodes[2].lane)
  expect(graph.edges.find(edge => edge.parent === 'outside')?.to).toBeNull()
})

it('bounds unusual ancestry without allocating lanes for parents outside the observation', () => {
  const parents = Array.from({ length: 3000 }, (_, index) => `outside-${index}`)
  const graph = layoutCommits([{ hash: 'head', parentHashes: parents, subject: '', timestamp: '' }])
  expect(graph.laneCount).toBe(1)
  expect(graph.edges).toHaveLength(2000)
  expect(graph.edgesOmitted).toBe(1000)
  expect(graph.edges.every(edge => parents.includes(edge.parent) && edge.to === null)).toBe(true)
})
