'use strict';
/**
 * 工作流库。
 *
 * 每个工作流针对一个真实重复劳动场景,串联多个 MCP 服务。
 * 变量传递用 ${step.field} 模板。
 */

/**
 * 技术调研闭环 —— 回答"这个技术现在什么水平"这件事。
 *
 * 步骤:
 *   1. 搜经验库:这个主题以前踩过什么坑(避免重犯)
 *   2. 多源检索:拿到候选资料
 *   3. 抓全文:把链接变成真内容
 *   4. 存资料库:归档到统一分类
 *
 * 痛点对应:信息处理与整理 —— 每次调研都重复这套动作。
 */
const researchFlow = {
  id: 'tech_research',
  name: '技术调研闭环',
  description: '经验库查重 → 多源检索 → 全文抓取 → 归档资料库',
  steps: [
    {
      id: 'precheck',
      tool: 'hlib-mcp::experience_search',
      args: { query: '${keyword}' },
      optional: true,
      retries: 1,
      timeout_ms: 30000,
    },
    {
      id: 'search',
      tool: 'search-engine::search',
      args: {
        keyword: '${keyword}',
        type: '${type}',
        limit: '${limit}',
      },
      retries: 2,
      timeout_ms: 90000,
    },
    {
      id: 'archive',
      tool: 'hlib-mcp::material_save',
      args: {
        name: '${keyword}_调研',
        category: '01',
        type: '报告',
        // 用字段级引用 ${search.results} 而不是整个 ${search}:
        // 前者只取结果数组,避免把整个检索响应(含 stats/platforms 等元数据)搬进归档
        content: '关键词:${keyword}\n\n检索结果:\n${search.results}',
        // 同名文件已存在时覆盖 —— 否则重复跑同一关键词会一直失败
        overwrite: true,
      },
      // 有副作用:同一关键词只归档一次,重跑时复用上次结果
      idempotency_key: 'archive:${keyword}',
      optional: true,
      retries: 1,
      timeout_ms: 30000,
    },
  ],
};

/**
 * 图片理解与归档 —— 看懂一张图/一张截图,并把结论落库。
 *
 * 步骤:
 *   1. 视觉模型读图
 *   2. 存资料库
 *
 * 痛点对应:信息处理与整理 —— 截图里的信息要用,不能只留在脑子里。
 */
const imageUnderstandFlow = {
  id: 'image_understand',
  name: '图片理解与归档',
  description: '视觉模型读图 → 结论存资料库',
  steps: [
    {
      id: 'describe',
      tool: 'vision-mcp::vision_describe_image',
      args: {
        image: '${image}',
        question: '${question}',
      },
      retries: 2,
      timeout_ms: 300000,
    },
    {
      id: 'archive',
      tool: 'hlib-mcp::material_save',
      args: {
        name: '${title}',
        category: '02',
        type: '文档',
        content: '图片理解结果:\n${describe}',
      },
      idempotency_key: 'archive-img:${title}',
      optional: true,
      retries: 1,
      timeout_ms: 30000,
    },
  ],
};

/**
 * 经验沉淀闭环 —— 一次踩坑,自动落经验库。
 *
 * 步骤:
 *   1. 按项目取开工前必读(通用精华 + 防错清单)
 *   2. 写当日收件箱
 *
 * 痛点对应:写代码与开发效率 —— 教训如果不落库,下次还会踩。
 */
const lessonFlow = {
  id: 'lesson_capture',
  name: '经验沉淀闭环',
  description: '开工前读防错清单 → 踩坑写入收件箱',
  steps: [
    {
      id: 'precheck',
      tool: 'experience-mcp::experience_precheck',
      args: { project: '${project}' },
      optional: true,
      retries: 1,
      timeout_ms: 30000,
    },
    {
      id: 'save',
      tool: 'experience-mcp::experience_save',
      args: {
        kind: '${kind}',
        scope: '${scope}',
        summary: '${summary}',
        case: '${case}',
        userSaid: '${userSaid}',
        judgment: '${judgment}',
      },
      retries: 2,
      timeout_ms: 30000,
    },
  ],
};

/**
 * 代码理解闭环 —— 导入代码库,写深度标注,查覆盖统计。
 *
 * 步骤:
 *   1. 导入/刷新项目
 *   2. 读文件
 *   3. 写标注
 *   4. 查统计
 *
 * 痛点对应:写代码与开发效率 —— 学陌生代码库的低效点。
 */
const codeStudyFlow = {
  id: 'code_study',
  name: '代码理解闭环',
  description: '导入代码库 → 读文件 → 写深度标注 → 查覆盖统计',
  steps: [
    {
      id: 'import',
      tool: 'cv-annot::annot_import_project',
      args: { name: '${project_name}', root: '${project_root}' },
      // 项目已存在是正常情况(重复运行),不算失败
      optional: true,
      retries: 1,
      timeout_ms: 60000,
    },
    {
      id: 'reimport',
      tool: 'cv-annot::annot_reimport',
      args: { name: '${project_name}' },
      optional: true,
      retries: 1,
      timeout_ms: 60000,
    },
    {
      id: 'read',
      tool: 'cv-annot::annot_get_file',
      args: { project: '${project_name}', path: '${file_path}' },
      retries: 2,
      timeout_ms: 30000,
    },
    {
      id: 'summary',
      tool: 'cv-annot::annot_summary',
      args: { project: '${project_name}' },
      optional: true,
      retries: 1,
      timeout_ms: 30000,
    },
  ],
};

/** 内容创作闭环 —— 配图 + 生图 + 存档。
 *
 * 步骤:
 *   1. 搜参考图
 *   2. 生成配图
 *   3. 归档提示词与产物
 */
const contentFlow = {
  id: 'content_visual',
  name: '内容配图闭环',
  description: '搜参考图 → 生成配图 → 归档提示词',
  steps: [
    {
      id: 'refs',
      tool: 'search-engine::search_images',
      args: { keyword: '${keyword}', limit: '${limit}', sources: 'bing,wikimedia' },
      optional: true,
      retries: 1,
      timeout_ms: 60000,
    },
    {
      id: 'generate',
      tool: 'image-mcp::image_generate_image',
      args: {
        prompt: '${prompt}',
        size: '${size}',
        n: '${n}',
      },
      retries: 2,
      timeout_ms: 300000,
    },
    {
      id: 'archive',
      tool: 'hlib-mcp::material_save',
      args: {
        name: '${keyword}_配图',
        category: '05',
        type: '素材',
        content: '提示词:${prompt}\n\n生成结果:\n${generate}',
      },
      optional: true,
      retries: 1,
      timeout_ms: 30000,
    },
  ],
};

const FLOWS = {
  tech_research: researchFlow,
  image_understand: imageUnderstandFlow,
  lesson_capture: lessonFlow,
  code_study: codeStudyFlow,
  content_visual: contentFlow,
};

module.exports = { FLOWS, researchFlow, imageUnderstandFlow, lessonFlow, codeStudyFlow, contentFlow };
