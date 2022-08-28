import classNames from "classnames";
import React from "react";

interface Props {
  id: string;
  className?: string;
  name: string;
  color: string;
  selected: boolean;
  handleSelection: (key: string) => void;
}

export class FacetTagChip extends React.PureComponent<Props> {
  render() {
    return (
      <div
        className={classNames("facet-chip", this.props.className, {
          deselected: !this.props.selected,
        })}
        onClick={() => this.props.handleSelection(this.props.id)}
        style={{ backgroundColor: this.props.color }}
      >
        <span className="facet-chip__label">{this.props.name}</span>
      </div>
    );
  }
}

export default FacetTagChip;
