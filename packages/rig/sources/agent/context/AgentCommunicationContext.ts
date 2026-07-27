export interface AgentCommunicationIdentity {
    agentId: string;
    /** Portable working-folder label, not a container-local absolute path. */
    folder: string;
    title?: string;
}

export type AgentCommunicationInfo =
    | (AgentCommunicationIdentity & {
          diskShared: true;
          path: string;
      })
    | (Pick<AgentCommunicationIdentity, "agentId" | "title"> & {
          diskShared: false;
          notice: string;
      });

export interface AgentCommunicationContext {
    info(agentId: string): AgentCommunicationInfo;
    me(): AgentCommunicationIdentity;
    send(agentId: string, message: string): { delivered: true };
}
