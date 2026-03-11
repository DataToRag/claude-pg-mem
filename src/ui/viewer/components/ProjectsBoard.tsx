import React from 'react';
import { Observation, Summary } from '../types';
import { ProjectColumn } from './ProjectColumn';
import { useProjectsBoard } from '../hooks/useProjectsBoard';

interface ProjectsBoardProps {
  projects: string[];
  observations: Observation[];
  summaries: Summary[];
  onViewProjectInFeed: (project: string) => void;
}

export function ProjectsBoard({ projects, observations, summaries, onViewProjectInFeed }: ProjectsBoardProps) {
  const { projectData, columnOrder, isLoading } = useProjectsBoard(projects, observations, summaries);

  if (isLoading && columnOrder.length === 0) {
    return (
      <div className="projects-board">
        <div className="projects-board-content">
          {projects.map(p => (
            <div key={p} className="project-column project-column-skeleton">
              <div className="project-column-header">
                <div className="project-column-name skeleton-text" />
              </div>
              <div className="project-column-items">
                <div className="skeleton-card" />
                <div className="skeleton-card" />
                <div className="skeleton-card" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (columnOrder.length === 0) {
    return (
      <div className="projects-board">
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--color-text-secondary)' }}>
          No projects found
        </div>
      </div>
    );
  }

  return (
    <div className="projects-board">
      <div className="projects-board-content">
        {columnOrder.map(project => (
          <ProjectColumn
            key={project}
            project={project}
            items={projectData.get(project) ?? []}
            onViewInFeed={onViewProjectInFeed}
          />
        ))}
      </div>
    </div>
  );
}
