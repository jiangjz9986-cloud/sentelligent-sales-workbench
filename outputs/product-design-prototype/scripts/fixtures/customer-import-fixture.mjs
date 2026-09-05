export function createCustomerImportFixture(runId) {
  const suffix = String(runId).trim();
  const source = `专项 C 临时来源：客户导入替代路径 ${suffix}`;

  return {
    name: `专项 C 导入验收客户 ${suffix}`,
    region: "青岛验收",
    type: "客户档案验收",
    level: "验收客户",
    contact: "专项 C / QA 联系人",
    relation: 68,
    budget: "临时验收窗口",
    summary: "由专项 C 临时 fixture 通过真实客户 API 创建，用于验证客户资料在 UI 中的渲染与编辑保存。",
    needs: ["验证导入字段完整呈现", "验证客户详情可追溯"],
    risks: ["当前产品没有文件导入入口"],
    infrastructure: ["临时 SQLite fixture，不连接生产数据库"],
    opportunities: [],
    stakeholders: [],
    decisionChain: [],
    historyProjects: [],
    syncPreview: [source],
    aliases: [`专项 C 别名 ${suffix}`],
    tags: ["专项C", "临时fixture"],
  };
}
