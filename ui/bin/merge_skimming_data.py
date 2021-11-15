import os
import json

input_dirs = [
    "src/data/sections",
    "src/data/captions",
    "src/data/facets",
    "src/data/sentences",
    "src/data/abstract",
]

# Specify the arxiv ids for the papers used in the user study
# so we build a merged data file with only those papers
selected_arxiv_ids = ["2102.09039", "1602.06979", "2104.03820"]

uist_papers = [f"uist-{i}" for i in range(9)]
selected_arxiv_ids += uist_papers

cur_id = 0
for input_dir in input_dirs:
    merged = {}
    for data_e in os.scandir(input_dir):
        id, ext = os.path.splitext(data_e.name)
        if id == "skimmingData":
            continue

        if id not in selected_arxiv_ids:
            continue

        if ext != ".json":
            continue

        with open(data_e.path, "r") as f:
            data = json.load(f)
            # add unique id to each data entry
            for x in data:
                x["id"] = str(cur_id)
                cur_id += 1
            if input_dir in ["src/data/sentences"]:
                data = [x for x in data if x["section"] != ""]
            merged[id] = data

    with open(f"{input_dir}/skimmingData.json", "w") as out:
        json.dump(merged, out)
