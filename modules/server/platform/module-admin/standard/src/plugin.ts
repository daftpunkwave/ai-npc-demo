/**
 * 向控制台提供去实现细节的模块描述符、装配列表与三 realm 解析结果。
 * 依赖调用方在宿主完成读盘和解析后绑定的数据；不自行启动模块或修改装配。
 * 禁止返回模块工厂、凭据、原始配置覆盖或未经解析的任意文件内容。
 */
import {
  DomainError,
  type AssemblyDetailResponse,
  type AssemblyDescriptor,
  type AssemblySource,
  type ModuleDefinition,
  type ModuleDescriptorView,
  type ModuleInstance,
  type ModulesResponse,
  type ResolvedModuleSet,
  type ModuleCreateInput,
} from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export interface AdminAssembly {
  readonly source: AssemblySource;
  readonly descriptor: AssemblyDescriptor;
  readonly resolved: {
    readonly server: ResolvedModuleSet;
    readonly client: ResolvedModuleSet;
    readonly console: ResolvedModuleSet;
  };
}

export interface ModuleAdminSnapshot {
  readonly catalogHash: string;
  readonly definitions: readonly ModuleDefinition[];
  readonly assemblies: readonly AdminAssembly[];
}

export class ModuleAdminPort {
  private snapshot: ModuleAdminSnapshot | null = null;

  bind(snapshot: ModuleAdminSnapshot): void {
    this.snapshot = snapshot;
  }

  modules(realm?: "server" | "client" | "console"): ModulesResponse {
    const current = this.requireSnapshot();
    return {
      catalogHash: current.catalogHash,
      modules: current.definitions
        .filter((definition) => realm === undefined || definition.realm === realm)
        .map(descriptorView),
    };
  }

  assemblies(): readonly { readonly assemblyId: string; readonly source: AssemblySource }[] {
    return this.requireSnapshot().assemblies.map((assembly) => ({
      assemblyId: assembly.descriptor.assemblyId,
      source: assembly.source,
    }));
  }

  assembly(assemblyId: string): AssemblyDetailResponse {
    const assembly = this.requireSnapshot().assemblies.find(
      (candidate) => candidate.descriptor.assemblyId === assemblyId,
    );
    if (assembly === undefined) {
      throw new DomainError("not-found", `装配 ${assemblyId} 不存在`);
    }
    return {
      descriptor: assembly.descriptor,
      resolved: assembly.resolved,
    };
  }

  private requireSnapshot(): ModuleAdminSnapshot {
    if (this.snapshot === null) {
      throw new DomainError("not-ready", "模块目录尚未绑定");
    }
    return this.snapshot;
  }
}

function descriptorView(definition: ModuleDefinition): ModuleDescriptorView {
  return {
    moduleId: definition.id as ModuleDescriptorView["moduleId"],
    realm: definition.realm,
    kind: definition.kind,
    version: definition.version,
    apiVersion: definition.apiVersion,
    provides: [...definition.provides],
    requires: [...definition.requires],
    ownsAggregates: [...(definition.ownsAggregates ?? [])],
    configJsonSchema: z.toJSONSchema(definition.configSchema) as ModuleDescriptorView["configJsonSchema"],
    experimentAxes: [...(definition.experimentAxes ?? [])],
  };
}

export function createModuleAdminModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, new ModuleAdminPort());
}
