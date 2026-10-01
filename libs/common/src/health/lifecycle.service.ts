import { Injectable } from '@nestjs/common';

/** Tracks whether this instance is draining so readiness can fail first. */
@Injectable()
export class LifecycleService {
  private draining = false;

  get isDraining() {
    return this.draining;
  }

  startDraining() {
    this.draining = true;
  }
}
