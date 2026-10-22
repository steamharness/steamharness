import { ResourceMembersPanel } from "@/components/ResourceMembersPanel";
import type { DetailPageProps } from "./types";
export function ProjectMembersTab({project}:DetailPageProps){
  return <div className="flex min-w-0 flex-1 flex-col p-4 lg:p-6">{project.access&&<ResourceMembersPanel key={project.id} type="project" id={project.id} access={project.access}/>}</div>;
}
