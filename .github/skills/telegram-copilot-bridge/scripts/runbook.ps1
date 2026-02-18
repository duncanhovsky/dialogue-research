param(
  [ValidateSet('build','start','daemon','test')]
  [string]$Action = 'build'
)

switch ($Action) {
  'build' {
    npm install
    npm run build
  }
  'start' {
    npm run start
  }
  'daemon' {
    npm run start:daemon
  }
  'test' {
    npm run test
  }
}
