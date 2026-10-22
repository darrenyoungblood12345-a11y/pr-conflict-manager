export const LANGUAGE_FIXTURES = [
  {
    path: 'sample.js', language: 'javascript',
    source: 'class Store { save() { function validate() { return true } return validate() } }\nconst load = () => 1\n',
    expected: ['Store', 'Store.save', 'Store.save.validate', 'load'],
  },
  {
    path: 'sample.ts', language: 'typescript',
    source: 'class Store { save(value: string): string { function validate(): boolean { return true } return value } }\nconst load = (id: number): number => id\n',
    expected: ['Store', 'Store.save', 'Store.save.validate', 'load'],
  },
  {
    path: 'sample.tsx', language: 'tsx',
    source: 'function App() { const render = () => <span>Ready</span>; return render() }\n',
    expected: ['App', 'App.render'],
  },
  {
    path: 'sample.py', language: 'python',
    source: 'class Store:\n    def save(self):\n        def validate():\n            return True\n        return validate()\n\ndef load():\n    return 1\n',
    expected: ['Store', 'Store.save', 'Store.save.validate', 'load'],
  },
  {
    path: 'sample.go', language: 'go',
    source: 'package sample\ntype Store struct {}\nfunc (s *Store) Save() bool { return true }\nfunc Load() bool { return true }\n',
    expected: ['Store', 'Store.Save', 'Load'],
  },
  {
    path: 'sample.rs', language: 'rust',
    source: 'struct Store {}\nimpl Store { fn save(&self) -> bool { fn validate() -> bool { true } validate() } }\nfn load() -> bool { true }\n',
    expected: ['Store', 'Store.save', 'Store.save.validate', 'load'],
  },
  {
    path: 'Sample.java', language: 'java',
    source: 'class Store { Store() {} boolean save() { return true; } }\n',
    expected: ['Store', 'Store.Store', 'Store.save'],
  },
  {
    path: 'sample.c', language: 'c',
    source: 'struct Store { int ready; };\nint save(void) { return 1; }\nint load(void) { return 2; }\n',
    expected: ['Store', 'save', 'load'],
  },
  {
    path: 'sample.cpp', language: 'cpp',
    source: 'namespace app { class Store { public: int save() { return 1; } }; int load() { return 2; } }\n',
    expected: ['app', 'app.Store', 'app.Store.save', 'app.load'],
  },
  {
    path: 'Sample.cs', language: 'c_sharp',
    source: 'namespace App { class Store { public Store() {} public bool Save() { bool Validate() { return true; } return Validate(); } } }\n',
    expected: ['App', 'App.Store', 'App.Store.Store', 'App.Store.Save', 'App.Store.Save.Validate'],
  },
  {
    path: 'sample.rb', language: 'ruby',
    source: 'module App\n  class Store\n    def save\n      true\n    end\n  end\nend\ndef load\n  true\nend\n',
    expected: ['App', 'App.Store', 'App.Store.save', 'load'],
  },
  {
    path: 'sample.php', language: 'php',
    source: '<?php\nclass Store { function save() { function validate() { return true; } return validate(); } }\nfunction load() { return true; }\n',
    expected: ['Store', 'Store.save', 'Store.save.validate', 'load'],
  },
  {
    path: 'sample.swift', language: 'swift',
    source: 'class Store {\n  func save() -> Bool {\n    func validate() -> Bool { return true }\n    return validate()\n  }\n}\nfunc load() -> Bool { return true }\n',
    expected: ['Store', 'Store.save', 'Store.save.validate', 'load'],
  },
  {
    path: 'sample.kt', language: 'kotlin',
    source: 'class Store {\n  fun save(): Boolean {\n    fun validate(): Boolean { return true }\n    return validate()\n  }\n}\nfun load(): Boolean { return true }\n',
    expected: ['Store', 'Store.save', 'Store.save.validate', 'load'],
  },
] as const
