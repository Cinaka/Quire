let name
export function initialize(value) {
  if (name) throw Error('一次性测试不可重用，请重新载入')
  name = value
}
export function databaseName() {
  if (!name) throw Error('尚未由受控入口启动')
  return name
}
