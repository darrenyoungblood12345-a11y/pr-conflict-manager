import { expect, it } from 'vitest'
import { githubIdentity } from './github-identity.js'

it('compares GitHub owners and repositories through a canonical ASCII identity', () => {
  expect(githubIdentity('https://github.com/Example/Project.git')).toEqual({ owner: 'example', repo: 'project' })
  expect(githubIdentity('git@github.com:Example/Project.git')).toEqual({ owner: 'example', repo: 'project' })
  expect(githubIdentity('https://github.com/example/project.git.git')).toEqual({ owner: 'example', repo: 'project.git' })
})
