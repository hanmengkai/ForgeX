import { describe, expect, it } from "vitest";

import {
  PostgresPlatformConfigurationRepository,
  type PostgresPlatformConfigurationPool,
  type PostgresQueryResult,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";

class PlatformConfigurationPool implements PostgresPlatformConfigurationPool {
  readonly customers: Array<Record<string, unknown>> = [];
  readonly projects: Array<Record<string, unknown>> = [];
  readonly repositories: Array<Record<string, unknown>> = [];
  nextErrorCode: string | null = null;

  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult> {
    if (this.nextErrorCode) {
      const code = this.nextErrorCode;
      this.nextErrorCode = null;
      throw Object.assign(new Error("模拟 PostgreSQL 约束错误"), { code });
    }
    if (text.startsWith("SELECT customer_key")) {
      return {
        rows: this.customers.filter((row) => row.tenant_key === values[0]),
      };
    }
    if (text.startsWith("SELECT project_key")) {
      return {
        rows: this.projects.filter((row) => row.tenant_key === values[0]),
      };
    }
    if (text.startsWith("SELECT repository_key")) {
      return {
        rows: this.repositories.filter((row) => row.tenant_key === values[0]),
      };
    }
    if (text.startsWith("INSERT INTO forgex_platform_customers")) {
      const row = {
        customer_key: values[0],
        tenant_key: values[1],
        name: values[2],
        summary: values[3],
        enabled: true,
        revision: 1,
      };
      this.customers.push(row);
      return { rows: [row] };
    }
    if (text.startsWith("INSERT INTO forgex_platform_projects")) {
      const customer = this.customers.find(
        (row) => row.tenant_key === values[1] && row.customer_key === values[2],
      );
      if (!customer) return { rows: [] };
      const row = {
        project_key: values[0],
        tenant_key: values[1],
        customer_key: values[2],
        name: values[3],
        summary: values[4],
        enabled: true,
        revision: 1,
      };
      this.projects.push(row);
      return { rows: [row] };
    }
    if (text.startsWith("INSERT INTO forgex_platform_repositories")) {
      const project = this.projects.find(
        (row) => row.tenant_key === values[1] && row.project_key === values[2],
      );
      if (!project) return { rows: [] };
      const row = {
        repository_key: values[0],
        tenant_key: values[1],
        project_key: values[2],
        name: values[3],
        git_url: values[4],
        local_path: values[5],
        default_branch: values[6],
        enabled: true,
        revision: 1,
      };
      this.repositories.push(row);
      return { rows: [row] };
    }
    if (text.startsWith("UPDATE forgex_platform_customers")) {
      const row = this.customers.find(
        (item) =>
          item.tenant_key === values[0] &&
          item.customer_key === values[1] &&
          item.revision === values[2],
      );
      if (!row) return { rows: [] };
      Object.assign(row, {
        name: values[3],
        summary: values[4],
        enabled: values[5],
        revision: Number(row.revision) + 1,
      });
      return { rows: [row] };
    }
    if (text.startsWith("UPDATE forgex_platform_projects")) {
      const row = this.projects.find(
        (item) =>
          item.tenant_key === values[0] &&
          item.project_key === values[1] &&
          item.revision === values[2],
      );
      if (!row) return { rows: [] };
      Object.assign(row, {
        name: values[3],
        summary: values[4],
        enabled: values[5],
        revision: Number(row.revision) + 1,
      });
      return { rows: [row] };
    }
    if (text.startsWith("UPDATE forgex_platform_repositories")) {
      const row = this.repositories.find(
        (item) =>
          item.tenant_key === values[0] &&
          item.repository_key === values[1] &&
          item.revision === values[2],
      );
      if (!row) return { rows: [] };
      Object.assign(row, {
        name: values[3],
        git_url: values[4],
        local_path: values[5],
        default_branch: values[6],
        enabled: values[7],
        revision: Number(row.revision) + 1,
      });
      return { rows: [row] };
    }
    if (text.startsWith("DELETE FROM forgex_platform_repositories")) {
      return this.remove(this.repositories, "repository_key", values);
    }
    if (text.startsWith("DELETE FROM forgex_platform_projects")) {
      return this.remove(this.projects, "project_key", values);
    }
    if (text.startsWith("DELETE FROM forgex_platform_customers")) {
      return this.remove(this.customers, "customer_key", values);
    }
    if (text.startsWith("SELECT 1 FROM forgex_platform_")) {
      const table = text.match(/FROM (forgex_platform_[a-z]+)/u)?.[1];
      const source =
        table === "forgex_platform_customers"
          ? this.customers
          : table === "forgex_platform_projects"
            ? this.projects
            : this.repositories;
      const key =
        table === "forgex_platform_customers"
          ? "customer_key"
          : table === "forgex_platform_projects"
            ? "project_key"
            : "repository_key";
      return {
        rows: source.some(
          (row) => row.tenant_key === values[0] && row[key] === values[1],
        )
          ? [{ exists: 1 }]
          : [],
      };
    }
    throw new Error(`未预期的 SQL: ${text}`);
  }

  private remove(
    source: Array<Record<string, unknown>>,
    key: string,
    values: unknown[],
  ): PostgresQueryResult {
    const index = source.findIndex(
      (row) =>
        row.tenant_key === values[0] &&
        row[key] === values[1] &&
        row.revision === values[2],
    );
    if (index < 0) return { rows: [] };
    source.splice(index, 1);
    return { rows: [{ [key]: values[1] }] };
  }
}

describe("PostgreSQL 客户项目配置仓储", () => {
  it("完成客户、项目和多个代码仓库的增改查删", async () => {
    const pool = new PlatformConfigurationPool();
    const repository = new PostgresPlatformConfigurationRepository(pool);
    const customer = await repository.createCustomer(tenantKey, {
      name: "保险事业群",
      summary: "负责保险客户的智能交付项目",
    });
    const project = await repository.createProject(
      tenantKey,
      customer.customerKey,
      { name: "智能质检平台", summary: "管理质检规则与模型交付" },
    );
    const code = await repository.createRepository(
      tenantKey,
      project.projectKey,
      {
        name: "控制面",
        gitUrl: "https://gitee.com/example/control-plane.git",
        localPath: "D:\\forgex\\control-plane",
        defaultBranch: "main",
      },
    );
    await repository.createRepository(tenantKey, project.projectKey, {
      name: "模型服务",
      gitUrl: "git@gitee.com:example/model-service.git",
      localPath: "/srv/forgex/model-service",
      defaultBranch: "master",
    });

    await expect(repository.list(tenantKey)).resolves.toMatchObject([
      {
        name: "保险事业群",
        projects: [
          {
            name: "智能质检平台",
            repositories: [{ name: "控制面" }, { name: "模型服务" }],
          },
        ],
      },
    ]);
    await expect(
      repository.updateCustomer(tenantKey, customer.customerKey, {
        expectedRevision: 1,
        name: "保险与金融事业群",
        summary: "负责保险与金融客户的智能交付项目",
        enabled: true,
      }),
    ).resolves.toMatchObject({ revision: 2, name: "保险与金融事业群" });
    await expect(
      repository.updateProject(tenantKey, project.projectKey, {
        expectedRevision: 1,
        name: "智能质量平台",
        summary: "管理质量规则、模型与交付",
        enabled: true,
      }),
    ).resolves.toMatchObject({ revision: 2, name: "智能质量平台" });
    await expect(
      repository.updateRepository(tenantKey, code.repositoryKey, {
        expectedRevision: 1,
        name: "业务控制面",
        gitUrl: "https://gitee.com/example/control-plane.git",
        localPath: "E:\\forgex\\control-plane",
        defaultBranch: "release",
        enabled: false,
      }),
    ).resolves.toMatchObject({ revision: 2, enabled: false });

    await repository.deleteRepository(tenantKey, code.repositoryKey, {
      expectedRevision: 2,
    });
    const remaining = (await repository.list(tenantKey))[0]!.projects[0]!
      .repositories[0]!;
    await repository.deleteRepository(tenantKey, remaining.repositoryKey, {
      expectedRevision: 1,
    });
    await repository.deleteProject(tenantKey, project.projectKey, {
      expectedRevision: 2,
    });
    await repository.deleteCustomer(tenantKey, customer.customerKey, {
      expectedRevision: 2,
    });
    await expect(repository.list(tenantKey)).resolves.toEqual([]);
  });

  it("把唯一约束、外键约束、缺失资源和过期修订转换为可读错误", async () => {
    const pool = new PlatformConfigurationPool();
    const repository = new PostgresPlatformConfigurationRepository(pool);
    const customer = await repository.createCustomer(tenantKey, {
      name: "制造事业群",
      summary: "负责制造行业客户项目",
    });

    pool.nextErrorCode = "23505";
    await expect(
      repository.createCustomer(tenantKey, {
        name: "制造事业群",
        summary: "重复的制造行业客户项目",
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });
    await expect(
      repository.createProject(
        tenantKey,
        "99999999-9999-4999-8999-999999999999",
        { name: "未知项目", summary: "客户不存在时不能创建" },
      ),
    ).rejects.toMatchObject({ code: "platform_configuration_not_found" });
    await expect(
      repository.updateCustomer(tenantKey, customer.customerKey, {
        expectedRevision: 99,
        name: customer.name,
        summary: customer.summary,
        enabled: true,
      }),
    ).rejects.toMatchObject({
      code: "platform_configuration_revision_conflict",
    });

    pool.nextErrorCode = "23503";
    await expect(
      repository.deleteCustomer(tenantKey, customer.customerKey, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });
  });
});
